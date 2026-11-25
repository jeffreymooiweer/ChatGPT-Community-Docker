"""Exercise release discovery and promotion without network or Docker."""
import hashlib
import importlib.util
import json
import os
from contextlib import contextmanager
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


class BuildContractTests(unittest.TestCase):
    def test_upstream_summary_fix_is_validated_without_reapplying_obsolete_diff(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertNotIn("remote-mobile-reasoning-summary.patch", dockerfile)
        self.assertFalse((ROOT / "patches/remote-mobile-reasoning-summary.patch").exists())
        self.assertIn("UPSTREAM_SOURCE=/src node --test /tmp/unraid-tests/*.test.cjs", dockerfile)
        checksum = dockerfile.index("sha256sum -c -")
        extract = dockerfile.index("dpkg-deb --fsys-tarfile /tmp/chatgpt.deb")
        integration = dockerfile.index("OFFICIAL_ASAR=/tmp/official-contract/usr/lib/chatgpt/resources/app.asar")
        build = dockerfile.index("UPSTREAM_DEB=/tmp/chatgpt.deb make build-app")
        self.assertLess(checksum, extract)
        self.assertLess(extract, integration)
        self.assertLess(integration, build)


@unittest.skipUnless(shutil.which("jq"), "jq is required for the release resolver")
class ReleaseTests(unittest.TestCase):
    def resolve(self, mode="discover", changed=False, invalid=False,
                discovery_failure=False, candidate_change=None,
                missing_candidate=False):
        recorded_bytes = (ROOT / "upstream-state.json").read_bytes()
        recorded = json.loads(recorded_bytes)
        candidate = {key: recorded[key] for key in (
            "wrapper_sha", "official_version", "official_path", "official_sha256")}
        if changed:
            candidate.update({
                "wrapper_sha": "a" * 40,
                "official_version": "99.1.0",
                "official_path": "pool/main/c/chatgpt/chatgpt_99.1.0_amd64.deb",
                "official_sha256": "b" * 64,
            })
        if invalid:
            candidate["official_sha256"] = "invalid"
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            checkout = folder / "checkout"
            checkout.mkdir()
            recorded_path = checkout / "upstream-state.json"
            recorded_path.write_bytes(recorded_bytes)
            staged = candidate | {
                "base_sha": "c" * 40,
                "source_tree": "d" * 64,
                "generation": "123",
            }
            if candidate_change:
                staged.update(candidate_change)
            candidate_path = checkout / "upstream-candidate.json"
            if not missing_candidate:
                candidate_path.write_text(json.dumps(staged))
            candidate_bytes = candidate_path.read_bytes() if candidate_path.exists() else None
            runner_temp = folder / "runner"
            runner_temp.mkdir()
            bin_dir = folder / "bin"
            bin_dir.mkdir()
            # Git and Node are only mocked at the discovery boundary; execute
            # the actual resolver's validation and candidate-verification logic.
            commands = {
                "git": '#!/bin/bash\nset -eu\necho git >> "$CALLS"\nif [ "$1" = clone ]; then mkdir -p "${@: -1}"; else echo "$TEST_SHA"; fi\n',
                "node": textwrap.dedent("""\
                    #!/bin/bash
                    set -eu
                    echo node >> "$CALLS"
                    if [ "$TEST_DISCOVERY_EXIT_STATUS" != 0 ]; then
                        echo 'fixture: signed metadata verification failed' >&2
                        exit "$TEST_DISCOVERY_EXIT_STATUS"
                    fi
                    cp "$METADATA" "$RUNNER_TEMP/package.json"
                    """),
            }
            for name, body in commands.items():
                path = bin_dir / name
                path.write_text(body)
                path.chmod(0o755)
            metadata = folder / "metadata.json"
            metadata.write_text(json.dumps({"version": candidate["official_version"],
                                            "repositoryPath": candidate["official_path"],
                                            "sha256": candidate["official_sha256"]}))
            output = folder / "output"
            calls = folder / "calls"
            env = os.environ | {"RESOLVE_MODE": mode,
                                "RUNNER_TEMP": str(runner_temp), "GITHUB_OUTPUT": str(output),
                                "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
                                "CALLS": str(calls), "METADATA": str(metadata),
                                "TEST_SHA": candidate["wrapper_sha"],
                                "TEST_DISCOVERY_EXIT_STATUS": "42" if discovery_failure else "0"}
            result = subprocess.run(["bash", str(ROOT / "scripts/resolve-upstream.sh")],
                                    cwd=checkout, env=env,
                                    text=True, capture_output=True)
            outputs = dict(line.split("=", 1) for line in output.read_text().splitlines()) if output.exists() else {}
            self.assertEqual(recorded_path.read_bytes(), recorded_bytes,
                             "Discovery must not change the last published upstream state")
            self.assertEqual(candidate_path.read_bytes() if candidate_path.exists() else None,
                             candidate_bytes, "Verification must not rewrite the candidate")
            discovered = calls.read_text().splitlines() if calls.exists() else []
            if result.returncode == 0:
                self.assertEqual(json.loads((runner_temp / "upstream-state.json").read_text()),
                                 candidate)
            return result, outputs, discovered, recorded, candidate

    def test_discovery_uses_current_signed_release_instead_of_recorded_release(self):
        result, output, discovered, recorded, candidate = self.resolve(changed=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("node", discovered)
        self.assertNotEqual(candidate["official_version"], recorded["official_version"])
        self.assertEqual(output, candidate)

    def test_unchanged_release_is_still_freshly_verified(self):
        for mode in ("discover", "verify-candidate"):
            with self.subTest(mode=mode):
                result, output, discovered, _, candidate = self.resolve(mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("node", discovered)
                self.assertEqual(output, candidate)

    def test_staging_build_receives_exact_current_verified_candidate(self):
        result, output, discovered, recorded, candidate = self.resolve(
            "verify-candidate", changed=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("node", discovered)
        self.assertNotEqual(candidate, recorded)
        self.assertEqual(output, candidate)

    def test_staging_rejects_upstream_drift_in_every_tuple_field(self):
        changes = {
            "wrapper_sha": "e" * 40,
            "official_version": "98.0.0",
            "official_path": "pool/main/c/chatgpt/chatgpt_98.0.0_amd64.deb",
            "official_sha256": "f" * 64,
        }
        for field, value in changes.items():
            with self.subTest(field=field):
                result, output, discovered, _, _ = self.resolve(
                    "verify-candidate", candidate_change={field: value})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("node", discovered)
                self.assertEqual(output, {}, "Do not substitute a newer unrecorded tuple")

    def test_staging_requires_candidate_metadata(self):
        result, output, _, _, _ = self.resolve("verify-candidate", missing_candidate=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, {})

    def test_discovery_failure_stops_before_build_outputs_without_falling_back(self):
        for mode in ("discover", "verify-candidate"):
            with self.subTest(mode=mode):
                result, output, discovered, _, _ = self.resolve(
                    mode, changed=True, discovery_failure=True)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertIn("node", discovered)
                self.assertEqual(output, {})

    def test_invalid_discovery_fails_before_build_outputs(self):
        result, output, _, _, _ = self.resolve(invalid=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, {})

    def test_unknown_resolver_mode_fails_closed(self):
        result, output, _, _, _ = self.resolve("unsupported")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, {})


class PromotionContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("release_helper", ROOT / "scripts/release.py")
        cls.release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.release)

    def upstream(self):
        return {
            "wrapper_sha": "a" * 40,
            "official_version": "99.1.0",
            "official_path": "pool/main/c/chatgpt/chatgpt_99.1.0_amd64.deb",
            "official_sha256": "b" * 64,
        }

    def candidate(self):
        return self.upstream() | {
            "base_sha": "c" * 40,
            "source_tree": "d" * 64,
            "generation": "12345",
        }

    def test_upstream_validation_returns_only_verified_tuple_fields(self):
        self.assertEqual(self.release.validate_upstream(self.candidate()), self.upstream())

    def test_required_tuple_fields_and_unsafe_values_are_rejected(self):
        for field in self.upstream():
            value = self.upstream()
            del value[field]
            with self.subTest(missing=field), self.assertRaises((ValueError, RuntimeError)):
                self.release.validate_upstream(value)
        invalid = {
            "wrapper_sha": ("main", "a" * 39, "A" * 40, None, 42),
            "official_sha256": ("b" * 63, "B" * 64, "digest", None),
            "official_version": ("", "99.1.0\nwrapper_sha=x", "$(command)", None),
            "official_path": (
                "https://example.invalid/app.deb", "pool/../app.deb", "pool/./app.deb",
                "pool//app.deb", "pool/main/app.deb?query=1", "pool/main/app.rpm", None,
            ),
        }
        for field, values in invalid.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises((ValueError, RuntimeError)):
                    self.release.validate_upstream(self.upstream() | {field: value})

    def test_candidate_requires_base_source_and_generation(self):
        candidate = self.candidate()
        self.assertEqual(self.release.validate_candidate(candidate), candidate)
        for field in ("base_sha", "source_tree", "generation"):
            value = candidate.copy()
            del value[field]
            with self.subTest(missing=field), self.assertRaises((ValueError, RuntimeError)):
                self.release.validate_candidate(value)
        for field, value in (("base_sha", "main"), ("source_tree", "d" * 40),
                             ("generation", "previous"), ("generation", "12\n34")):
            with self.subTest(field=field, value=value), self.assertRaises((ValueError, RuntimeError)):
                self.release.validate_candidate(candidate | {field: value})

    def test_promotion_rejects_stale_branch_heads_and_changed_sources(self):
        candidate = self.candidate()
        exact = {
            "candidate_sha": "e" * 40,
            "staging_sha": "e" * 40,
            "main_sha": candidate["base_sha"],
            "actual_source_tree": candidate["source_tree"],
        }
        self.release.validate_promotion(candidate, **exact)
        for field in ("staging_sha", "main_sha", "actual_source_tree"):
            value = "f" * (64 if field == "actual_source_tree" else 40)
            with self.subTest(field=field), self.assertRaises((ValueError, RuntimeError)):
                self.release.validate_promotion(candidate, **(exact | {field: value}))

    def test_periodic_checks_skip_only_already_published_upstream_and_sources(self):
        candidate = self.upstream()
        source_hash = "d" * 64
        published = candidate | {"source_tree": source_hash}
        self.assertFalse(self.release.should_build(
            candidate, published, "schedule", "17 */6 * * *", source_hash))
        changed_cases = (
            (candidate | {"wrapper_sha": "e" * 40}, published, source_hash),
            (candidate | {"official_version": "99.2.0"}, published, source_hash),
            (candidate, published, "f" * 64),
            (candidate, self.upstream(), source_hash),
        )
        for discovered, receipt, source in changed_cases:
            with self.subTest(discovered=discovered, receipt=receipt, source=source):
                self.assertTrue(self.release.should_build(
                    discovered, receipt, "schedule", "17 */6 * * *", source))

    def test_weekly_manual_and_source_push_runs_require_full_build(self):
        candidate = self.upstream()
        source_hash = "d" * 64
        published = candidate | {"source_tree": source_hash}
        for event, schedule in (("schedule", "37 3 * * 0"),
                                ("workflow_dispatch", ""), ("push", "")):
            with self.subTest(event=event, schedule=schedule):
                self.assertTrue(self.release.should_build(
                    candidate, published, event, schedule, source_hash))

    def test_archive_verification_rejects_missing_or_changed_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "candidate.tar"
            archive.write_bytes(b"exact tested image archive")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            self.release.verify_archive(archive, digest)
            for invalid in ("", "invalid", "a" * 64):
                with self.subTest(digest=invalid), self.assertRaises((ValueError, RuntimeError)):
                    self.release.verify_archive(archive, invalid)
            archive.write_bytes(b"different image after validation")
            with self.assertRaises((ValueError, RuntimeError)):
                self.release.verify_archive(archive, digest)

    def test_image_identity_platform_and_provenance_must_match_tested_candidate(self):
        candidate = self.candidate()
        candidate_sha = "e" * 40
        expected_id = "sha256:" + "1" * 64
        labels = {
            "org.opencontainers.image.source": "https://github.com/example/project",
            "org.opencontainers.image.revision": candidate_sha,
            "org.opencontainers.image.version": candidate["official_version"],
        }
        image = {"Id": expected_id, "Os": "linux", "Architecture": "amd64",
                 "Config": {"Labels": labels}}
        self.release.validate_image(image, expected_id, candidate, candidate_sha, "example/project")
        invalid_images = [
            image | {"Id": "sha256:" + "2" * 64},
            image | {"Os": "windows"}, image | {"Architecture": "arm64"},
            image | {"Config": {}}, image | {"Config": {"Labels": None}},
        ]
        for key in labels:
            invalid_images.append(image | {"Config": {"Labels": labels | {key: "other"}}})
        for invalid in invalid_images:
            with self.subTest(image=invalid), self.assertRaises(RuntimeError):
                self.release.validate_image(
                    invalid, expected_id, candidate, candidate_sha, "example/project")

    def test_source_identity_ignores_release_metadata_but_tracks_real_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary)

            def git(*args):
                return subprocess.run(["git", *args], cwd=checkout, check=True,
                                      capture_output=True, text=True).stdout.strip()

            def commit(message):
                git("add", ".")
                git("commit", "-m", message)

            git("init", "-b", "main")
            git("config", "user.name", "Release tests")
            git("config", "user.email", "release-tests@example.invalid")
            source = checkout / "Dockerfile"
            source.write_text("FROM example.invalid/base:stable\n")
            (checkout / "upstream-state.json").write_text(json.dumps(self.upstream()))
            commit("Create source fixture")
            original = self.release.source_tree(cwd=checkout)
            (checkout / "upstream-state.json").write_text(json.dumps(self.upstream() | {
                "official_version": "99.2.0"}))
            (checkout / "upstream-candidate.json").write_text(json.dumps(self.candidate()))
            commit("Update release records")
            self.assertEqual(self.release.source_tree(cwd=checkout), original)
            source.write_text("FROM example.invalid/base:changed\n")
            commit("Change build source")
            self.assertNotEqual(self.release.source_tree(cwd=checkout), original)

    def successful_run(self, candidate_sha):
        return {
            "head_sha": candidate_sha,
            "head_branch": "staging",
            "path": ".github/workflows/build.yml",
            "event": "workflow_dispatch",
        }

    def successful_build(self):
        return {
            "name": "build", "status": "completed", "conclusion": "success",
            "steps": [{"name": name, "status": "completed", "conclusion": "success"}
                      for name in self.release.BUILD_STEPS],
        }

    def test_run_evidence_requires_exact_staging_source_and_real_build_steps(self):
        candidate_sha = "e" * 40
        api = mock.Mock()
        api.request.return_value = self.successful_run(candidate_sha)
        api.pages.return_value = [self.successful_build()]
        with mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "12345"}):
            self.release.verify_build_run(api, candidate_sha)
            for field, value in (("head_sha", "f" * 40), ("head_branch", "main"),
                                 ("path", ".github/workflows/unrelated.yml"),
                                 ("event", "pull_request")):
                api.request.return_value = self.successful_run(candidate_sha) | {field: value}
                with self.subTest(field=field), self.assertRaises(RuntimeError):
                    self.release.verify_build_run(api, candidate_sha)
            api.request.return_value = self.successful_run(candidate_sha)
            for outcome in ("skipped", "failure", "cancelled", None):
                for index, name in enumerate(self.release.BUILD_STEPS):
                    job = self.successful_build()
                    job["steps"][index]["conclusion"] = outcome
                    api.pages.return_value = [job]
                    with self.subTest(step=name, outcome=outcome), self.assertRaises(RuntimeError):
                        self.release.verify_build_run(api, candidate_sha)
            for jobs in ([], [self.successful_build(), self.successful_build()],
                         [self.successful_build() | {"status": "in_progress"}],
                         [self.successful_build() | {"conclusion": "failure"}]):
                api.pages.return_value = jobs
                with self.subTest(jobs=jobs), self.assertRaises(RuntimeError):
                    self.release.verify_build_run(api, candidate_sha)

    @contextmanager
    def promotion_fixture(self, failure=None):
        """Keep local Git and release validation real; replace remote boundaries."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "checkout"
            root.mkdir()
            runner = Path(temporary) / "runner"
            archive_dir = runner / "release-image"
            archive_dir.mkdir(parents=True)
            archive = archive_dir / "image.tar.gz"
            archive.write_bytes(b"tested Docker archive fixture")
            archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()

            def git(*args):
                return subprocess.run(["git", *args], cwd=root, check=True,
                                      text=True, capture_output=True).stdout.strip()

            git("init", "-b", "main")
            git("config", "user.name", "Release tests")
            git("config", "user.email", "release-tests@example.invalid")
            (root / "Dockerfile").write_text("FROM example.invalid/base:tested\n")
            state_path = root / "upstream-state.json"
            state_path.write_text(json.dumps(self.upstream() | {"official_version": "98.1.0"}))
            state_before = state_path.read_bytes()
            git("add", ".")
            git("commit", "-m", "Create published source fixture")
            base_sha = git("rev-parse", "HEAD")
            fingerprint = self.release.source_tree(cwd=root)
            candidate = self.candidate() | {"base_sha": base_sha, "source_tree": fingerprint}
            git("checkout", "-b", "staging")
            (root / "upstream-candidate.json").write_text(json.dumps(candidate))
            git("add", ".")
            git("commit", "-m", "Stage verified upstream fixture")
            candidate_sha = git("rev-parse", "HEAD")
            git("checkout", "main")
            git("merge", "--no-ff", "staging", "-m", "Merge tested release fixture")
            if failure == "merged-tree":
                (root / "Dockerfile").write_text("FROM example.invalid/base:untested\n")
                git("add", ".")
                git("commit", "-m", "Simulate an untested merged tree")
            merge_sha = git("rev-parse", "HEAD")
            git("checkout", "--detach", candidate_sha)

            calls = []
            api = mock.Mock()
            api.repository = "example/project"
            remote_main = ["f" * 40 if failure == "stale-main" else base_sha]
            image_id = "sha256:" + "1" * 64
            image_digest = "sha256:" + "2" * 64
            pr = {"number": 7, "head": {"sha": candidate_sha}, "draft": False,
                  "html_url": "https://github.com/example/project/pull/7", "mergeable": True}
            if failure == "review-blocked":
                pr["mergeable_state"] = "blocked"

            def api_ref(branch):
                if branch == "main":
                    return remote_main[0]
                if branch == "staging":
                    return "f" * 40 if failure == "stale-staging" else candidate_sha
                raise AssertionError(f"Unexpected branch read: {branch}")

            def api_request(method, path, data=None):
                calls.append(("api", method, path))
                if method == "GET" and path == "actions/runs/12345":
                    return self.successful_run(candidate_sha)
                if (method, path) in (("POST", "pulls"), ("GET", "pulls/7")):
                    return pr
                if (method, path) == ("PUT", "pulls/7/merge"):
                    self.assertEqual(data["sha"], candidate_sha)
                    remote_main[0] = merge_sha
                    return {"merged": True, "sha": merge_sha}
                if method == "GET" and path == f"commits/{candidate_sha}/status":
                    if failure == "pending-status":
                        return {"state": "pending", "statuses": [{"context": "required-policy"}]}
                    return {"state": "pending", "statuses": []}
                raise AssertionError(f"Unexpected API call: {method} {path}")

            def api_pages(path, key=None):
                if path == "actions/runs/12345/jobs?filter=latest":
                    return [self.successful_build()]
                if path == "pulls?state=open&base=main&head=example:staging":
                    return []
                if path == "pulls/7/reviews":
                    if failure == "changes-requested":
                        return [{"user": {"login": "maintainer"}, "state": "CHANGES_REQUESTED"}]
                    return []
                if path == f"commits/{candidate_sha}/check-runs?filter=latest":
                    checks = [{"name": "build", "status": "completed", "conclusion": "success"},
                              {"name": "prepare", "status": "completed", "conclusion": "skipped"},
                              {"name": "promote", "status": "in_progress", "conclusion": None}]
                    if failure == "pending-check":
                        checks.append({"name": "required-policy", "status": "queued", "conclusion": None})
                    return checks
                raise AssertionError(f"Unexpected API page: {path}")

            def external_command(*args, cwd=None, input=None):
                calls.append(tuple(args))
                if args[0] == "git":
                    if args[1] == "fetch":
                        return ""
                    if args[1:] == ("rev-parse", "FETCH_HEAD"):
                        return merge_sha
                    if args[1] == "push":
                        remote_main[0] = git("rev-parse", "HEAD")
                        return ""
                    return subprocess.run(args, cwd=cwd, input=input, check=True,
                                          text=True, capture_output=True).stdout.strip()
                if args[:3] == ("docker", "image", "inspect"):
                    return json.dumps({
                        "Id": "sha256:" + "3" * 64 if failure == "image-id" else image_id,
                        "Os": "linux", "Architecture": "amd64",
                        "Config": {"Labels": {
                            "org.opencontainers.image.source": "https://github.com/example/project",
                            "org.opencontainers.image.revision": candidate_sha,
                            "org.opencontainers.image.version": candidate["official_version"],
                        }},
                    })
                if args[:3] == ("docker", "buildx", "imagetools"):
                    if failure == "registry-digest" and args[4].endswith(":latest"):
                        return json.dumps({"digest": "sha256:" + "4" * 64})
                    return json.dumps({"digest": image_digest})
                if args[:2] == ("docker", "push"):
                    if ((failure == "build-push" and ":build-" in args[2])
                            or (failure == "latest-push" and args[2].endswith(":latest"))):
                        raise RuntimeError("Fixture registry push failed")
                    return ""
                if args[:2] in (("docker", "load"), ("docker", "tag")):
                    return ""
                raise AssertionError(f"Unexpected external command: {args}")

            api.ref.side_effect = api_ref
            api.request.side_effect = api_request
            api.pages.side_effect = api_pages
            environment = {
                "GITHUB_RUN_ID": "12345", "GITHUB_RUN_NUMBER": "190",
                "CANDIDATE_SHA": candidate_sha, "EXPECTED_IMAGE_ID": image_id,
                "EXPECTED_ARCHIVE_SHA256": archive_hash, "RUNNER_TEMP": str(runner),
                "GITHUB_OUTPUT": str(runner / "output"),
                "GITHUB_STEP_SUMMARY": str(runner / "summary"),
            }
            if failure == "archive":
                archive.write_bytes(b"tampered archive fixture")
            with mock.patch.dict(os.environ, environment), mock.patch.object(
                    self.release, "run", side_effect=external_command):
                yield SimpleNamespace(root=root, api=api, calls=calls, runner=runner,
                                      state_path=state_path, state_before=state_before,
                                      candidate=candidate, candidate_sha=candidate_sha,
                                      image_id=image_id, image_digest=image_digest)

    def test_prepare_preserves_unmerged_staging_source_changes(self):
        with self.promotion_fixture() as fixture:
            def git(*args):
                return subprocess.run(["git", *args], cwd=fixture.root, check=True,
                                      capture_output=True, text=True).stdout.strip()

            git("checkout", "staging")
            (fixture.root / "Dockerfile").write_text("FROM example.invalid/base:repair\n")
            git("add", ".")
            git("commit", "-m", "Preserve an unfinished staging repair")
            staging_sha = git("rev-parse", "HEAD")
            base_sha = fixture.candidate["base_sha"]
            git("checkout", "--detach", base_sha)
            fixture.api.ref.side_effect = lambda branch: base_sha if branch == "main" else staging_sha
            (fixture.runner / "upstream-state.json").write_text(json.dumps(self.upstream()))
            previous_boundary = self.release.run.side_effect

            def boundary(*args, **kwargs):
                if args == ("git", "rev-parse", "FETCH_HEAD"):
                    return staging_sha
                return previous_boundary(*args, **kwargs)

            with mock.patch.dict(os.environ, {"GITHUB_EVENT_NAME": "push", "SCHEDULE": ""}), \
                    mock.patch.object(self.release, "run", side_effect=boundary), \
                    self.assertRaisesRegex(RuntimeError, "unmerged source changes"):
                self.release.prepare(api=fixture.api, root=fixture.root)
            self.assertEqual(git("rev-parse", "staging"), staging_sha)
            self.assertEqual(fixture.state_path.read_bytes(), fixture.state_before)
            self.assertFalse(any(call[:2] == ("git", "push") for call in fixture.calls))

    def test_invalid_artifact_or_stale_candidate_fails_before_any_remote_mutation(self):
        for failure in ("archive", "image-id", "stale-main", "stale-staging"):
            with self.subTest(failure=failure), self.promotion_fixture(failure) as fixture:
                with self.assertRaises(RuntimeError):
                    self.release.promote(api=fixture.api, root=fixture.root)
                self.assertEqual(fixture.state_path.read_bytes(), fixture.state_before)
                self.assertFalse(any(call[:2] == ("docker", "push")
                                     or call[:2] == ("git", "push")
                                     or (call[0] == "api" and call[1] != "GET")
                                     for call in fixture.calls))

    def test_merged_tree_or_publication_failure_never_records_success(self):
        for failure in ("merged-tree", "build-push", "latest-push", "registry-digest"):
            with self.subTest(failure=failure), self.promotion_fixture(failure) as fixture:
                with self.assertRaises(RuntimeError):
                    self.release.promote(api=fixture.api, root=fixture.root)
                self.assertEqual(fixture.state_path.read_bytes(), fixture.state_before)
                self.assertFalse(any(call[:2] == ("git", "push") for call in fixture.calls))
                self.assertFalse((fixture.runner / "output").exists())
                if failure == "merged-tree":
                    self.assertFalse(any(call[:2] == ("docker", "push") for call in fixture.calls))

    def test_reviews_and_pending_checks_block_merge_and_publication(self):
        for failure in ("review-blocked", "changes-requested", "pending-check", "pending-status"):
            with self.subTest(failure=failure), self.promotion_fixture(failure) as fixture:
                with self.assertRaises(RuntimeError):
                    self.release.promote(api=fixture.api, root=fixture.root)
                self.assertEqual(fixture.state_path.read_bytes(), fixture.state_before)
                self.assertNotIn(("api", "PUT", "pulls/7/merge"), fixture.calls)
                self.assertFalse(any(call[:2] == ("docker", "push")
                                     or call[:2] == ("git", "push") for call in fixture.calls))

    def test_promotion_publishes_same_image_then_records_verified_receipt(self):
        with self.promotion_fixture() as fixture:
            self.release.promote(api=fixture.api, root=fixture.root)
            receipt = json.loads(fixture.state_path.read_text())
            for field, value in self.upstream().items():
                self.assertEqual(receipt[field], value)
            self.assertEqual(receipt["source_tree"], fixture.candidate["source_tree"])
            self.assertEqual(receipt["image_digest"], fixture.image_digest)
            self.assertEqual(receipt["image_tag"], f"build-190-{fixture.candidate_sha[:12]}")
            tags = [call for call in fixture.calls if call[:2] == ("docker", "tag")]
            self.assertEqual(len(tags), 2)
            self.assertTrue(all(call[2] == fixture.image_id for call in tags))
            build_push = next(i for i, call in enumerate(fixture.calls)
                              if call[:2] == ("docker", "push") and ":build-" in call[2])
            latest_push = next(i for i, call in enumerate(fixture.calls)
                               if call[:2] == ("docker", "push") and call[2].endswith(":latest"))
            latest_verified = next(i for i, call in enumerate(fixture.calls)
                                   if call[:3] == ("docker", "buildx", "imagetools")
                                   and call[4].endswith(":latest"))
            state_push = next(i for i, call in enumerate(fixture.calls)
                              if call[:2] == ("git", "push"))
            self.assertLess(build_push, latest_push)
            self.assertLess(latest_push, latest_verified)
            self.assertLess(latest_verified, state_push)
            self.assertFalse(any(call[0] == "node" or call[:2] == ("git", "clone")
                                 or call[:2] == ("docker", "build") for call in fixture.calls),
                             "Promotion must not discover or rebuild a different upstream")
