"""Offline regression tests; no account, GPU, Docker daemon or host access."""
import grp
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
INIT = ROOT / "root/custom-cont-init.d/10-chatgpt-unraid.sh"


class ConfigurationTests(unittest.TestCase):
    def test_documentation_examples_and_relative_links(self):
        for path in [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md"))]:
            text = path.read_text()
            self.assertEqual(len(re.findall(r"^```", text, re.M)) % 2, 0)
            for script in re.findall(r"```bash\n(.*?)```", text, re.S):
                subprocess.run(["bash", "-n"], input=script, text=True, check=True)
            for link in re.findall(r"\]\(([^)]+)\)", text):
                if not link.startswith(("https://", "http://", "#")):
                    self.assertTrue((path.parent / link.split("#")[0]).exists(), link)

    @unittest.skipUnless(shutil.which("docker"), "Docker CLI is required for offline Compose validation")
    def test_compose_standard_defaults(self):
        version = subprocess.run(["docker", "compose", "version"], capture_output=True)
        if version.returncode:
            self.skipTest("Compose plugin is not installed")
        result = subprocess.run(["docker", "compose", "-f", str(ROOT / "compose.yaml"),
                                 "config", "--format", "json"], check=True,
                                stdout=subprocess.PIPE, text=True)
        service = json.loads(result.stdout)["services"]["chatgpt-community"]
        self.assertEqual(service["environment"]["ENABLE_HOST_SSH"], "false")
        self.assertEqual(service["environment"]["PASSWORD"], "")
        self.assertEqual(service["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual([v["target"] for v in service["volumes"]], ["/config"])
        self.assertFalse(service.get("privileged", False))
        self.assertFalse(service.get("devices", []))
        self.assertNotIn("SSH_HOST", service["environment"])

    def test_build_context_excludes_local_userdata(self):
        ignores = (ROOT / ".dockerignore").read_text().splitlines()
        for entry in ("appdata", ".env", ".env.*"):
            self.assertIn(entry, ignores)

    def test_shell_syntax(self):
        for directory in (ROOT / "root", ROOT / "tests"):
            for path in directory.rglob("*"):
                if path.is_file() and path.read_bytes().startswith(b"#!/"):
                    with self.subTest(path=path):
                        subprocess.run(["bash", "-n", str(path)], check=True)

    def test_template(self):
        config = ET.parse(ROOT / "unraid/chatgpt-community.xml").getroot()
        self.assertEqual(config.findtext("Name"), "ChatGPT-Community")
        self.assertEqual(config.findtext("Privileged"), "false")
        settings = {node.attrib["Target"]: node for node in config.findall("Config")}
        self.assertEqual(settings["/config"].text, "/mnt/user/appdata/chatgpt-community")
        self.assertNotIn("/dev/dri", settings)
        self.assertFalse(settings["/workspace/files"].text)
        self.assertEqual(settings["/workspace/files"].attrib["Default"], "")
        self.assertEqual(settings["/workspace/files"].attrib["Required"], "false")
        self.assertEqual(settings["/workspace/files"].attrib["Mode"], "ro")
        self.assertEqual(settings["PASSWORD"].attrib["Mask"], "true")
        self.assertEqual(settings["PASSWORD"].attrib["Required"], "false")
        self.assertEqual(settings["PASSWORD"].attrib["Default"], "")
        self.assertFalse(settings["PASSWORD"].text)
        self.assertEqual(settings["CUSTOM_USER"].attrib["Required"], "false")
        self.assertEqual(settings["ENABLE_HOST_SSH"].text, "false")
        self.assertNotIn("UNRAID_HOST", settings)
        self.assertFalse(settings["SSH_HOST"].text)
        for key in ("ENABLE_HOST_SSH", "SSH_HOST", "SSH_USER", "SSH_PORT"):
            self.assertEqual(settings[key].attrib["Display"], "advanced")
        self.assertIn("--hostname=ChatGPT-Community", config.findtext("ExtraParams"))
        self.assertNotIn("/var/run/docker.sock", settings)

    def run_init(self, directory, password="test-only", ssh_setup=None,
                 host=None, user=None, port=None, legacy_host=None, expected_status=0):
        env = os.environ | {
            "CHATGPT_CONFIG_DIR": str(directory),
            "CHATGPT_DEFAULTS_DIR": str(ROOT / "root/defaults"),
            "CHATGPT_APP_USER": pwd.getpwuid(os.getuid()).pw_name,
            "CHATGPT_APP_GROUP": grp.getgrgid(os.getgid()).gr_name,
            "PASSWORD": password,
        }
        for key, value in {"ENABLE_HOST_SSH": ssh_setup, "SSH_HOST": host,
                           "SSH_USER": user, "SSH_PORT": port,
                           "UNRAID_HOST": legacy_host}.items():
            env.pop(key, None)
            if value is not None:
                env[key] = value
        result = subprocess.run(["bash", str(INIT)], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, expected_status, result.stderr)
        return result

    def test_standard_mode_does_not_provision_ssh(self):
        for setting in (None, "false"):
            with self.subTest(setting=setting), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                # Unused legacy/SSH values must not prevent normal app startup.
                self.run_init(directory, ssh_setup=setting, host="unused invalid host")
                self.run_init(directory, ssh_setup=setting)
                self.assertFalse((directory / ".ssh").exists())
                self.assertFalse((directory / "workspace/unraid").exists())
                self.assertFalse((directory / "workspace/server").exists())
                self.assertTrue((directory / "workspace").is_dir())
                self.assertTrue((directory / ".config/labwc/autostart").is_file())

    def test_disabled_setup_preserves_existing_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            preserved = {".ssh/id_ed25519": "existing-private-key-fixture\n",
                         ".ssh/config": "Host unraid\n HostName server.example\n",
                         ".ssh/known_hosts": "known-host-fixture\n",
                         "workspace/unraid/AGENTS.md": "Custom user instructions\n"}
            for name, text in preserved.items():
                path = directory / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            before = {p: (p.read_bytes(), p.stat().st_mode) for p in directory.rglob("*") if p.is_file()}
            self.run_init(directory)
            self.run_init(directory, ssh_setup="false")
            for path, state in before.items():
                self.assertEqual((path.read_bytes(), path.stat().st_mode), state)
            self.assertFalse((directory / ".ssh/id_ed25519.pub").exists())

    @unittest.skipUnless(shutil.which("ssh-keygen"), "OpenSSH client is required")
    def test_advanced_nonroot_setup_and_legacy_host(self):
        for use_legacy in (False, True):
            with self.subTest(legacy=use_legacy), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                host_args = {"legacy_host" if use_legacy else "host": "server.example"}
                self.run_init(directory, ssh_setup="true", user="operator", port="2222", **host_args)
                config = (directory / ".ssh/config").read_text()
                for text in ("Host server unraid", "HostName server.example", "User operator", "Port 2222"):
                    self.assertIn(text, config)
                self.assertEqual((directory / ".ssh/id_ed25519").stat().st_mode & 0o777, 0o600)
                self.assertNotIn("Root access is available", (directory / "workspace/server/AGENTS.md").read_text())

    def test_invalid_ssh_settings_fail_before_key_creation(self):
        cases = [{"ssh_setup": "yes"}, {"ssh_setup": "true"},
                 {"ssh_setup": "true", "host": "server\nProxyCommand bad"},
                 {"ssh_setup": "true", "host": "-bad"},
                 {"ssh_setup": "true", "host": "server", "user": "bad user"},
                 {"ssh_setup": "true", "host": "server", "port": "65536"},
                 {"ssh_setup": "true", "host": "server", "port": "0"},
                 {"ssh_setup": "true", "host": "server", "port": "abc"}]
        for settings in cases:
            with self.subTest(settings=settings), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                self.run_init(directory, expected_status=1, **settings)
                self.assertFalse((directory / ".ssh").exists())

    @unittest.skipUnless(shutil.which("ssh-keygen"), "OpenSSH client is required")
    def test_optional_webui_password(self):
        for password in ("", "test-only"):
            with self.subTest(password_set=bool(password)), tempfile.TemporaryDirectory() as temporary:
                result = self.run_init(Path(temporary), password=password)
                self.assertEqual("WebUI login disabled" in result.stderr, not bool(password))

    @unittest.skipUnless(shutil.which("ssh-keygen"), "OpenSSH client is required")
    def test_migration_preserves_credentials_and_user_edits(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            preserved = {
                ".codex/auth.json": '{"test":"existing-account"}\n',
                ".config/Codex/Local State": '{"test":"existing-profile"}\n',
                ".config/codex-desktop/remote-control-device-keys/keys.json": "paired-device\n",
                ".config/codex-desktop/electron-flags.conf": "--no-sandbox\n",
                ".ssh/config": "Host unraid\n    HostName 192.0.2.123\n",
                ".ssh/known_hosts": "existing-known-host\n",
                "workspace/unraid/AGENTS.md": "User-customized instructions\n",
            }
            for name, value in preserved.items():
                path = directory / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
            legacy = directory / ".config/autostart/chatgpt-community.desktop"
            legacy.parent.mkdir(parents=True)
            legacy.write_text("[Desktop Entry]\nExec=old-launcher\n")
            for wm in ("labwc", "openbox"):
                path = directory / f".config/{wm}/autostart"
                path.parent.mkdir(parents=True)
                path.write_text("exit 0\n")
            self.run_init(directory, ssh_setup="true")
            key = (directory / ".ssh/id_ed25519").read_bytes()
            self.run_init(directory, ssh_setup="true", host="ignored invalid host")
            self.assertEqual(key, (directory / ".ssh/id_ed25519").read_bytes())
            for name, value in preserved.items():
                with self.subTest(path=name):
                    self.assertEqual((directory / name).read_text(), value)
            backup = directory / ".local/state/chatgpt-community/migration-single-app-v1"
            self.assertFalse(legacy.exists())
            self.assertTrue((backup / "chatgpt-community.desktop").exists())
            for wm in ("labwc", "openbox"):
                self.assertEqual((backup / f"{wm}-autostart").read_text(), "exit 0\n")
                self.assertIn("start-chatgpt-community", (directory / f".config/{wm}/autostart").read_text())

    @unittest.skipUnless(shutil.which("ssh-keygen"), "OpenSSH client is required")
    def test_fresh_config_and_missing_public_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.run_init(directory, ssh_setup="true", host="192.0.2.1")
            self.assertIn("ssh unraid", (directory / "workspace/server/AGENTS.md").read_text())
            original = (directory / ".ssh/id_ed25519").read_bytes()
            (directory / ".ssh/id_ed25519.pub").unlink()
            self.run_init(directory, ssh_setup="true")
            self.assertEqual(original, (directory / ".ssh/id_ed25519").read_bytes())
            self.assertTrue((directory / ".ssh/id_ed25519.pub").read_text().startswith("ssh-ed25519 "))


if __name__ == "__main__":
    unittest.main()
