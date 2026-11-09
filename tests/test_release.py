"""Exercise the workflow's real resolver script without network or Docker."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BuildContractTests(unittest.TestCase):
    def test_upstream_fix_is_validated_without_reapplying_local_diff(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertNotIn("git apply", dockerfile)
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
    def resolve(self, event, schedule="", changed=False, invalid=False,
                discovery_failure=False):
        workflow = (ROOT / ".github/workflows/build.yml").read_text()
        step = workflow.split("      - name: Resolve upstream\n", 1)[1].split("\n      - name:", 1)[0]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1])
        recorded_bytes = (ROOT / "upstream-state.json").read_bytes()
        recorded = json.loads(recorded_bytes)
        candidate = dict(recorded)
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
            runner_temp = folder / "runner"
            runner_temp.mkdir()
            bin_dir = folder / "bin"
            bin_dir.mkdir()
            # Git and Node are only mocked at the discovery boundary; execute
            # the actual workflow's validation and build-decision logic.
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
            env = os.environ | {"EVENT_NAME": event, "SCHEDULE": schedule,
                                "RUNNER_TEMP": str(runner_temp), "GITHUB_OUTPUT": str(output),
                                "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
                                "CALLS": str(calls), "METADATA": str(metadata),
                                "TEST_SHA": candidate["wrapper_sha"],
                                "TEST_DISCOVERY_EXIT_STATUS": "42" if discovery_failure else "0"}
            result = subprocess.run(["bash", "-c", script], cwd=checkout, env=env,
                                    text=True, capture_output=True)
            outputs = dict(line.split("=", 1) for line in output.read_text().splitlines()) if output.exists() else {}
            self.assertEqual(recorded_path.read_bytes(), recorded_bytes,
                             "Discovery must not change the last published upstream state")
            discovered = calls.read_text().splitlines() if calls.exists() else []
            return result, outputs, discovered, recorded, candidate

    def test_code_changes_discover_current_release_instead_of_recorded_release(self):
        for event in ("push", "pull_request"):
            with self.subTest(event=event):
                result, output, discovered, recorded, candidate = self.resolve(event, changed=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("node", discovered)
                self.assertNotEqual(candidate["official_version"], recorded["official_version"])
                self.assertEqual(output["should_build"], "true")
                self.assertEqual(output["changed"], "true")
                for key, value in candidate.items():
                    self.assertEqual(output[key], value)

    def test_code_changes_still_build_when_discovery_is_unchanged(self):
        for event in ("push", "pull_request"):
            with self.subTest(event=event):
                result, output, discovered, _, candidate = self.resolve(event)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("node", discovered)
                self.assertEqual(output["should_build"], "true")
                self.assertEqual(output["changed"], "false")
                for key, value in candidate.items():
                    self.assertEqual(output[key], value)

    def test_scheduled_checks_skip_unchanged_but_weekly_refresh_builds(self):
        for schedule, should_build in (("17 */6 * * *", "false"), ("37 3 * * 0", "true")):
            with self.subTest(schedule=schedule):
                result, output, discovered, _, _ = self.resolve("schedule", schedule)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("node", discovered)
                self.assertEqual(output["changed"], "false")
                self.assertEqual(output["should_build"], should_build)

    def test_new_upstream_is_still_tested_on_schedule_and_manual_runs(self):
        for event in ("schedule", "workflow_dispatch"):
            with self.subTest(event=event):
                result, output, discovered, _, candidate = self.resolve(event, changed=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("node", discovered)
                self.assertEqual(output["changed"], "true")
                self.assertEqual(output["should_build"], "true")
                for key, value in candidate.items():
                    self.assertEqual(output[key], value)

    def test_discovery_failure_stops_before_build_outputs_without_falling_back(self):
        for event in ("push", "pull_request", "schedule", "workflow_dispatch"):
            with self.subTest(event=event):
                result, output, discovered, _, _ = self.resolve(
                    event, changed=True, discovery_failure=True)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertIn("node", discovered)
                self.assertEqual(output, {})

    def test_invalid_discovery_fails_before_build_outputs(self):
        result, output, _, _, _ = self.resolve("schedule", invalid=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("should_build", output)
