#!/usr/bin/env python3
"""Prepare staging candidates and promote only their tested Docker image."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request


UPSTREAM_FIELDS = ("wrapper_sha", "official_version", "official_path", "official_sha256")
METADATA_FILES = {"upstream-state.json", "upstream-candidate.json"}
WEEKLY_SCHEDULE = "37 3 * * 0"
BUILD_STEPS = (
    "Validate scripts and persistent-data migration",
    "Resolve upstream",
    "Build candidate without publishing",
    "Test X11 and Wayland startup, HTTPS and restart persistence",
    "Export the successfully tested image",
    "Preserve the exact image for promotion",
)
BOT_NAME = "github-actions[bot]"
BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"


def run(*args, cwd=None, input=None):
    """Run arguments directly; never evaluate repository or API data as shell."""
    result = subprocess.run(args, cwd=cwd, input=input, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {result.stderr.strip()}")
    return result.stdout.strip()


def validate_upstream(data):
    if not isinstance(data, dict):
        raise ValueError("Upstream metadata must be an object")
    patterns = {
        "wrapper_sha": r"[0-9a-f]{40}",
        "official_sha256": r"[0-9a-f]{64}",
        "official_version": r"[0-9][0-9A-Za-z.+:~\-]*",
        "official_path": r"pool/[A-Za-z0-9._+\-/]+\.deb",
    }
    for name, pattern in patterns.items():
        value = data.get(name)
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise ValueError(f"Invalid {name}")
    if any(part in ("", ".", "..") for part in data["official_path"].split("/")):
        raise ValueError("Unsafe official package path")
    return {name: data[name] for name in UPSTREAM_FIELDS}


def validate_candidate(data):
    validate_upstream(data)
    for name, pattern in (("base_sha", r"[0-9a-f]{40}"),
                          ("source_tree", r"[0-9a-f]{64}"),
                          ("generation", r"[0-9]+")):
        if not isinstance(data.get(name), str) or not re.fullmatch(pattern, data[name]):
            raise ValueError(f"Invalid candidate {name}")
    return dict(data)


def source_tree(ref="HEAD", cwd=None):
    """Hash source paths, modes and blob IDs independently of release receipts."""
    entries = subprocess.check_output(["git", "ls-tree", "-r", "-z", ref], cwd=cwd)
    retained = []
    for entry in entries.split(b"\0"):
        if entry and entry.split(b"\t", 1)[1].decode("utf-8") not in METADATA_FILES:
            retained.append(entry + b"\0")
    return hashlib.sha256(b"".join(retained)).hexdigest()


def should_build(candidate, published, event, schedule, source_hash):
    return (validate_upstream(candidate) != validate_upstream(published)
            or published.get("source_tree") != source_hash
            or event != "schedule" or schedule == WEEKLY_SCHEDULE)


def validate_promotion(candidate, candidate_sha, staging_sha, main_sha, actual_source_tree):
    validate_candidate(candidate)
    if not re.fullmatch(r"[0-9a-f]{40}", candidate_sha):
        raise ValueError("Invalid candidate commit")
    if staging_sha != candidate_sha:
        raise RuntimeError("Staging advanced after this candidate was tested")
    if main_sha != candidate["base_sha"]:
        raise RuntimeError("Main advanced after this candidate was prepared")
    if actual_source_tree != candidate["source_tree"]:
        raise RuntimeError("Candidate source differs from the prepared source tree")


def verify_archive(path, expected_sha256):
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("Invalid expected image archive checksum")
    digest = hashlib.sha256()
    with Path(path).open("rb") as archive:
        for block in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != expected_sha256:
        raise RuntimeError("Tested image archive checksum mismatch")


def validate_image(image, expected_id, candidate, candidate_sha, repository):
    if image.get("Id") != expected_id:
        raise RuntimeError("Loaded Docker image differs from the tested image ID")
    if image.get("Os") != "linux" or image.get("Architecture") != "amd64":
        raise RuntimeError("Tested Docker image has an unexpected platform")
    labels = image.get("Config", {}).get("Labels", {}) or {}
    expected = {"org.opencontainers.image.revision": candidate_sha,
                "org.opencontainers.image.version": candidate["official_version"],
                "org.opencontainers.image.source": f"https://github.com/{repository}"}
    if any(labels.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Tested Docker image provenance does not match the candidate")


def output(name, value):
    value = str(value)
    if "\n" in value or "\r" in value:
        raise ValueError("Multiline workflow output is not allowed")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as target:
        target.write(f"{name}={value}\n")


def summary(message):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as target:
        target.write(message + "\n")


class GitHubError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(f"GitHub HTTP {status}: {message}")
        self.status = status


class GitHub:
    def __init__(self, repository=None, token=None):
        self.repository = repository or os.environ["GITHUB_REPOSITORY"]
        self.token = token or os.environ["GH_TOKEN"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", self.repository):
            raise ValueError("Invalid repository")

    def request(self, method, path, data=None):
        url = f"https://api.github.com/repos/{self.repository}/{path.lstrip('/')}"
        request = urllib.request.Request(
            url, method=method,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Authorization": f"Bearer {self.token}",
                     "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28",
                     "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise GitHubError(error.code, body) from error
        return json.loads(body) if body else None

    def pages(self, path, key=None):
        result = []
        for page in range(1, 101):
            separator = "&" if "?" in path else "?"
            data = self.request("GET", f"{path}{separator}per_page=100&page={page}")
            batch = data[key] if key else data
            result.extend(batch)
            if len(batch) < 100:
                return result
        raise RuntimeError("GitHub pagination exceeded the safe limit")

    def ref(self, branch):
        return self.request("GET", f"git/ref/heads/{branch}")["object"]["sha"]


def configure_bot(root):
    run("git", "config", "user.name", BOT_NAME, cwd=root)
    run("git", "config", "user.email", BOT_EMAIL, cwd=root)


def prepare(api=None, root=None):
    api = api or GitHub()
    root = Path(root or ".").resolve()
    if run("git", "status", "--porcelain", cwd=root):
        raise RuntimeError("Candidate preparation requires a clean checkout")
    base = run("git", "rev-parse", "HEAD", cwd=root)
    if api.ref("main") != base:
        raise RuntimeError("Main advanced before candidate preparation; use a fresh run")
    discovered = json.loads((Path(os.environ["RUNNER_TEMP"]) / "upstream-state.json").read_text())
    upstream = validate_upstream(discovered)
    published = json.loads((root / "upstream-state.json").read_text())
    fingerprint = source_tree(base, root)
    if not should_build(upstream, published, os.environ["GITHUB_EVENT_NAME"],
                        os.environ.get("SCHEDULE", ""), fingerprint):
        output("should_build", "false")
        summary("The signed upstream and published source are unchanged; no candidate is needed.")
        return
    candidate = upstream | {"base_sha": base, "source_tree": fingerprint,
                            "generation": os.environ["GITHUB_RUN_ID"]}
    validate_candidate(candidate)
    try:
        staging = api.ref("staging")
    except GitHubError as error:
        if error.status != 404:
            raise
        staging = None
    configure_bot(root)
    if staging:
        run("git", "fetch", "origin", "refs/heads/staging", cwd=root)
        fetched = run("git", "rev-parse", "FETCH_HEAD", cwd=root)
        if fetched != staging:
            raise RuntimeError("Staging advanced during candidate preparation")
        ancestor = run("git", "merge-base", base, staging, cwd=root)
        changed = run("git", "diff", "--name-only", ancestor, staging, cwd=root).splitlines()
        if any(path != "upstream-candidate.json" for path in changed):
            raise RuntimeError("Staging contains unmerged source changes; preserve and finish its repair PR first")
        run("git", "checkout", "-b", "staging", staging, cwd=root)
        run("git", "merge", "--no-edit", base, cwd=root)
    else:
        run("git", "checkout", "-b", "staging", base, cwd=root)
    if source_tree("HEAD", root) != fingerprint:
        raise RuntimeError("Staging source does not match current main")
    (root / "upstream-candidate.json").write_text(json.dumps(candidate, indent=2, sort_keys=True) + "\n")
    run("git", "add", "upstream-candidate.json", cwd=root)
    run("git", "commit", "-m", f"chore: stage upstream {upstream['official_version']}", cwd=root)
    if api.ref("main") != base:
        raise RuntimeError("Main advanced while preparing the candidate; nothing was pushed")
    run("git", "push", "origin", "HEAD:refs/heads/staging", cwd=root)
    candidate_sha = run("git", "rev-parse", "HEAD", cwd=root)
    api.request("POST", "actions/workflows/build.yml/dispatches",
                {"ref": "staging", "inputs": {"candidate_sha": candidate_sha}})
    output("should_build", "true")
    output("candidate_sha", candidate_sha)
    summary(f"Prepared staging candidate `{candidate_sha}` for application `{upstream['official_version']}`. "
            "The full staging build was dispatched; main and latest were not changed.")


def verify_build_run(api, candidate_sha):
    run_id = os.environ["GITHUB_RUN_ID"]
    current = api.request("GET", f"actions/runs/{run_id}")
    if (current.get("head_sha") != candidate_sha or current.get("head_branch") != "staging"
            or current.get("path", "").split("@", 1)[0] != ".github/workflows/build.yml"
            or current.get("event") not in ("workflow_dispatch", "push")):
        raise RuntimeError("Promotion requires this repository's exact staging workflow run")
    jobs = api.pages(f"actions/runs/{run_id}/jobs?filter=latest", "jobs")
    matches = [job for job in jobs if job.get("name") == "build"]
    if len(matches) != 1 or matches[0].get("conclusion") != "success":
        raise RuntimeError("The current staging build job did not complete successfully")
    job = matches[0]
    if job.get("status") != "completed":
        raise RuntimeError("The staging build job is not complete")
    for name in BUILD_STEPS:
        steps = [step for step in job.get("steps", []) if step.get("name") == name]
        if (len(steps) != 1 or steps[0].get("conclusion") != "success"
                or steps[0].get("status") != "completed"):
            raise RuntimeError(f"Required build step did not run successfully: {name}")


def ready_pull_request(api, candidate_sha):
    owner = api.repository.split("/", 1)[0]
    prs = api.pages(f"pulls?state=open&base=main&head={owner}:staging")
    if len(prs) > 1:
        raise RuntimeError("Multiple staging release pull requests exist")
    if prs:
        pr = prs[0]
    else:
        pr = api.request("POST", "pulls", {
            "title": "chore: promote tested staging release", "head": "staging", "base": "main",
            "body": "Promote the exact staging candidate after its Docker build, official-app compatibility tests, "
                    "and all three smoke scenarios passed. Publication reuses the tested image artifact; "
                    "upstream-state.json is recorded only after both image tags are verified.",
        })
    number = pr["number"]
    pr = api.request("GET", f"pulls/{number}")
    for _ in range(5):
        if pr.get("mergeable") is not None:
            break
        time.sleep(2)
        pr = api.request("GET", f"pulls/{number}")
    if pr.get("mergeable") is None:
        raise RuntimeError("GitHub has not finished computing pull request mergeability")
    if pr.get("draft") or pr.get("head", {}).get("sha") != candidate_sha:
        raise RuntimeError("The release pull request is a draft or its head changed")
    reviews = api.pages(f"pulls/{number}/reviews")
    latest = {}
    for review in reviews:
        if review.get("state") in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            latest[review["user"]["login"]] = review["state"]
    if "CHANGES_REQUESTED" in latest.values():
        raise RuntimeError("The release pull request has an unresolved changes-requested review")
    checks = api.pages(f"commits/{candidate_sha}/check-runs?filter=latest", "check_runs")
    for check in checks:
        if check.get("name") == "promote":
            continue
        if check.get("name") == "prepare" and check.get("conclusion") == "skipped":
            continue
        if check.get("conclusion") != "success" or check.get("status") != "completed":
            raise RuntimeError(f"Commit check is not successful: {check.get('name')}")
    statuses = api.request("GET", f"commits/{candidate_sha}/status")
    if statuses.get("statuses") and statuses.get("state") != "success":
        raise RuntimeError("A commit status has not succeeded")
    if pr.get("mergeable") is False or pr.get("mergeable_state") in ("dirty", "blocked", "draft"):
        raise RuntimeError("GitHub reports the release pull request is blocked")
    return pr


def registry_digest(image):
    manifest = json.loads(run("docker", "buildx", "imagetools", "inspect", image,
                              "--format", "{{json .Manifest}}"))
    digest = manifest.get("digest")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise RuntimeError("Registry did not return a valid image manifest digest")
    return digest


def promote(api=None, root=None):
    api = api or GitHub()
    root = Path(root or ".").resolve()
    candidate_sha = os.environ["CANDIDATE_SHA"]
    if run("git", "rev-parse", "HEAD", cwd=root) != candidate_sha:
        raise RuntimeError("Promotion checkout does not match the tested candidate")
    candidate = validate_candidate(json.loads((root / "upstream-candidate.json").read_text()))
    expected_id = os.environ["EXPECTED_IMAGE_ID"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_id):
        raise ValueError("Invalid tested image ID")
    archive = Path(os.environ["RUNNER_TEMP"]) / "release-image" / "image.tar.gz"
    verify_archive(archive, os.environ["EXPECTED_ARCHIVE_SHA256"])
    run("docker", "load", "--input", str(archive))
    image_info = json.loads(run("docker", "image", "inspect", "chatgpt-community-ci:test",
                               "--format", "{{json .}}"))
    validate_image(image_info, expected_id, candidate, candidate_sha, api.repository)
    validate_promotion(candidate, candidate_sha, api.ref("staging"), api.ref("main"),
                       source_tree(candidate_sha, root))
    verify_build_run(api, candidate_sha)
    pr = ready_pull_request(api, candidate_sha)
    validate_promotion(candidate, candidate_sha, api.ref("staging"), api.ref("main"),
                       source_tree(candidate_sha, root))
    merged = api.request("PUT", f"pulls/{pr['number']}/merge", {
        "sha": candidate_sha, "merge_method": "merge",
        "commit_title": f"chore: promote tested upstream {candidate['official_version']}",
    })
    if not merged.get("merged"):
        raise RuntimeError("GitHub did not merge the tested release pull request")
    merge_sha = merged["sha"]
    run("git", "fetch", "origin", "refs/heads/main", cwd=root)
    if run("git", "rev-parse", "FETCH_HEAD", cwd=root) != merge_sha or api.ref("main") != merge_sha:
        raise RuntimeError("Main advanced during release promotion; no image was published")
    tested_tree = run("git", "rev-parse", f"{candidate_sha}^{{tree}}", cwd=root)
    if run("git", "rev-parse", f"{merge_sha}^{{tree}}", cwd=root) != tested_tree:
        raise RuntimeError("Merged source differs from the tested candidate; no image was published")
    image = f"ghcr.io/{api.repository.lower()}"
    tag = f"build-{os.environ['GITHUB_RUN_NUMBER']}-{candidate_sha[:12]}"
    run("docker", "tag", expected_id, f"{image}:{tag}")
    run("docker", "push", f"{image}:{tag}")
    build_digest = registry_digest(f"{image}:{tag}")
    if api.ref("main") != merge_sha or api.ref("staging") != candidate_sha:
        raise RuntimeError("A release branch advanced before latest promotion; latest was not changed")
    run("docker", "tag", expected_id, f"{image}:latest")
    run("docker", "push", f"{image}:latest")
    if registry_digest(f"{image}:latest") != build_digest:
        raise RuntimeError("Published latest and build tag do not contain the same image")
    if api.ref("main") != merge_sha:
        raise RuntimeError("Image published, but main advanced before its receipt could be recorded")
    receipt = validate_upstream(candidate) | {"source_tree": candidate["source_tree"],
                                             "image_digest": build_digest, "image_tag": tag}
    run("git", "checkout", "--detach", merge_sha, cwd=root)
    (root / "upstream-state.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    configure_bot(root)
    run("git", "add", "upstream-state.json", cwd=root)
    run("git", "commit", "-m", "chore: record successfully published staging release", cwd=root)
    run("git", "push", "origin", "HEAD:refs/heads/main", cwd=root)
    receipt_sha = run("git", "rev-parse", "HEAD", cwd=root)
    if api.ref("main") != receipt_sha:
        raise RuntimeError("Publication receipt could not be confirmed on main")
    for name, value in (("pr_url", pr["html_url"]), ("image_tag", tag),
                        ("image_digest", build_digest), ("application_version", candidate["official_version"])):
        output(name, value)
    summary(f"Merged [{pr['number']}]({pr['html_url']}) after staging validation. Published "
            f"`{image}:latest` and `{image}:{tag}` at `{build_digest}`, application "
            f"`{candidate['official_version']}`. Recorded publication in `{receipt_sha}`.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "promote"))
    args = parser.parse_args()
    {"prepare": prepare, "promote": promote}[args.command]()


if __name__ == "__main__":
    main()
