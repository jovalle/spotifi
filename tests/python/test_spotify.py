"""Behavioral coverage for the Python port; all app/process boundaries are isolated."""

import hashlib
import io
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import call, patch

from spotifi import cli as cli_api
from spotifi import config as settings
from spotifi import mini as mini_api
from spotifi import resources, tasks
from spotifi import spotify as spotify_api
from spotifi import system as system_api

FUNCTION_MODULES = {
    name: module.__name__.rsplit(".", 1)[-1]
    for module in (cli_api, settings, mini_api, spotify_api, system_api, tasks)
    for name, value in vars(module).items()
    if getattr(value, "__module__", None) == module.__name__
}


def result(code=0, output=""):
    return subprocess.CompletedProcess(["fixture"], code, output)


class IsolatedSpotify(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.spotify = self.home / "Spotify Resources"
        self.prefs = self.home / "prefs"
        self.config = self.home / "spicetify/config-xpui.ini"
        self.spotify.mkdir()
        self.prefs.touch()
        self.config.parent.mkdir()
        self.patch(
            "os.environ",
            {
                "HOME": str(self.home),
                "SPOTIFI_PLATFORM": "Linux",
                "SPOTIFI_MINI_DIR": str(self.home / "mini"),
            },
            dictionary=True,
        )
        self.patch("time.sleep")
        self.output = io.StringIO()
        self.redirect = redirect_stdout(self.output)
        self.addCleanup(self.redirect.__exit__, None, None, None)
        self.redirect.__enter__()

    def patch(self, name, *args, dictionary=False, **kwargs):
        module = "mini" if isinstance(self, MiniTests) else "spotify"
        target = (
            name
            if "." in name
            else "spotifi."
            + (module if name == "run" else FUNCTION_MODULES.get(name, module))
            + "."
            + name
        )
        patcher = (
            patch.dict(target, *args, clear=True, **kwargs)
            if dictionary
            else patch(target, *args, **kwargs)
        )
        mocked = patcher.start()
        self.addCleanup(patcher.stop)
        return mocked

    def write_config(self, extensions=(), version="1.2.3", extra=""):
        self.config.write_text(
            f"[Setting]\nspotify_path = {self.spotify}\nprefs_path = {self.prefs}\n"
            f"[AdditionalOptions]\nextensions = {'|'.join(extensions)}\n{extra}"
            f"\n[Backup]\nversion = {version}\n"
        )

    def install_bundle(self):
        xpui = self.spotify / "Apps/xpui"
        (xpui / "helper").mkdir(parents=True, exist_ok=True)
        (xpui / "extensions").mkdir(exist_ok=True)
        (xpui / "helper/spicetifyWrapper.js").write_text("wrapper")
        (xpui / "index.html").write_text(
            '<body><script src="helper/spicetifyWrapper.js"></script>'
            + "".join(
                f'<script src="extensions/{name}"></script>' for name in spotify_api.EXTENSIONS
            )
            + "</body>"
        )
        for name in spotify_api.EXTENSIONS:
            (xpui / "extensions" / name).write_bytes(
                (spotify_api.EXTENSION_DIR / name).read_bytes()
            )

    def spicetify(self, *args, check=True):
        args = tuple(str(arg) for arg in args)
        self.calls.append(args[1:])
        command = args[1:]
        if command == ("-c",):
            return result(output=str(self.config))
        if command == ("config",):
            return result(output="\x1b[1mBackup\x1b[0m\nversion 1.2.3")
        if command[:2] == ("config", "extensions"):
            name = command[2]
            extensions = spotify_api.config_value(self.config, "extensions").split("|")
            extensions = [item for item in extensions if item and item != name.rstrip("-")]
            if not name.endswith("-"):
                extensions.append(name)
            text = self.config.read_text()
            import re

            self.config.write_text(
                re.sub(
                    r"^extensions = .*$", "extensions = " + "|".join(extensions), text, flags=re.M
                )
            )
        if command[:2] == ("config", "spotify_path"):
            self.write_config()
        if command[0] == "--no-restart":
            self.install_bundle()
        return result()

    def fake_spicetify(self):
        self.calls = []
        return self.patch("run", side_effect=self.spicetify)

    def configured(self):
        self.write_config(spotify_api.EXTENSIONS)
        for name in spotify_api.EXTENSIONS:
            system_api.private_write(
                self.config.parent / "Extensions" / name,
                (spotify_api.EXTENSION_DIR / name).read_bytes(),
            )
        self.install_bundle()

    def configure_boundaries(self, running=True, current=False):
        self.patch("spotify_paths", return_value=(self.spotify, self.prefs))
        self.patch("ensure_spotify_writable")
        self.patch("ensure_spicetify", return_value="spicetify")
        self.patch("configuration_is_current", return_value=current)
        self.patch("spotify_is_running", return_value=running)
        self.patch("flatpak_is_running", return_value=True)
        self.close = self.patch("stop_spotify")
        self.open = self.patch("open_spotify")
        self.apply = self.patch("configure_spicetify")
        self.survives = self.patch("survives_relaunch", return_value=True)


class SpotifyTests(IsolatedSpotify):
    def test_explicit_paths(self):
        os.environ.update(
            SPOTIFI_SPOTIFY_PATH=str(self.spotify), SPOTIFI_SPOTIFY_PREFS=str(self.prefs)
        )
        self.assertEqual(spotify_api.spotify_paths(), (self.spotify, self.prefs))

    def test_invalid_explicit_paths_fail_before_setup(self):
        install = self.patch("ensure_spicetify")
        for override in (
            {"SPOTIFI_SPOTIFY_PATH": str(self.spotify)},
            {"SPOTIFI_SPOTIFY_PATH": "", "SPOTIFI_SPOTIFY_PREFS": str(self.prefs)},
            {"SPOTIFI_SPOTIFY_PATH": str(self.prefs), "SPOTIFI_SPOTIFY_PREFS": str(self.prefs)},
            {"SPOTIFI_SPOTIFY_PATH": str(self.spotify), "SPOTIFI_SPOTIFY_PREFS": str(self.spotify)},
        ):
            with (
                self.subTest(override=override),
                patch.dict(os.environ, override),
                self.assertRaises(ValueError),
            ):
                spotify_api.configure()
        install.assert_not_called()

    def test_mac_dependencies_already_installed_do_not_require_homebrew(self):
        os.environ["SPOTIFI_PLATFORM"] = "Darwin"
        (self.home / "Applications/Spotify.app").mkdir(parents=True)
        self.patch(
            "shutil.which",
            side_effect=lambda name: "/fixture/spicetify" if name == "spicetify" else None,
        )
        run = self.patch("run")
        spotify_api.dependencies()
        run.assert_not_called()

    def test_flatpak_discovery_on_arm_and_prefer_active_deployment(self):
        self.patch("shutil.which", return_value="/fixture/flatpak")
        self.patch("run", return_value=result(1))
        spotify = (
            self.home
            / ".local/share/flatpak/app/com.spotify.Client/aarch64/stable/active/files/extra/share/spotify"
        )
        prefs = self.home / ".var/app/com.spotify.Client/config/spotify/prefs"
        spotify.mkdir(parents=True)
        prefs.parent.mkdir(parents=True)
        prefs.touch()
        self.assertEqual(spotify_api.spotify_paths(), (spotify, prefs))
        deployment = self.home / "current"
        active = deployment / "files/extra/share/spotify"
        active.mkdir(parents=True)
        with patch.object(spotify_api, "run", return_value=result(output=str(deployment))):
            self.assertEqual(spotify_api.spotify_paths(), (active, prefs))

    def test_mac_user_install_and_missing_login(self):
        os.environ["SPOTIFI_PLATFORM"] = "Darwin"
        path = self.home / "Applications/Spotify.app/Contents/Resources"
        path.mkdir(parents=True)
        prefs = self.home / "Library/Application Support/Spotify/prefs"
        # Hide a real system installation while exercising the user installation.
        original = Path.is_dir
        with patch.object(
            Path,
            "is_dir",
            lambda path: False if str(path).startswith("/Applications/") else original(path),
        ):
            self.assertIsNone(spotify_api.spotify_paths())
            prefs.parent.mkdir(parents=True)
            prefs.touch()
            self.assertEqual(spotify_api.spotify_paths(), (path, prefs))

    def test_non_writable_linux_reports_quoted_commands(self):
        self.patch("os.access", return_value=False)
        with self.assertRaisesRegex(RuntimeError, "sudo chmod a\\+wr -- '.*Spotify Resources'"):
            spotify_api.ensure_spotify_writable(self.spotify)

    def test_missing_spotify_skips_spicetify(self):
        self.patch("spotify_paths", return_value=None)
        install = self.patch("ensure_spicetify")
        spotify_api.configure()
        install.assert_not_called()

    def test_missing_and_local_spicetify(self):
        self.patch("shutil.which", return_value=None)
        self.assertIsNone(spotify_api.spicetify_binary())
        with self.assertRaisesRegex(RuntimeError, "Homebrew"):
            spotify_api.ensure_spicetify()
        binary = self.home / ".spicetify/spicetify"
        binary.parent.mkdir()
        binary.write_text("fixture")
        binary.chmod(0o700)
        self.assertEqual(spotify_api.spicetify_binary(), str(binary))

    def test_dependencies_install_once_and_never_streamdeck_or_runtime(self):
        self.patch(
            "shutil.which",
            side_effect=lambda name: None if name == "spotify" else "/fixture/" + name,
        )
        flatpak = self.patch("flatpak_installed", side_effect=[False, True])
        binary = self.patch(
            "spicetify_binary", side_effect=[None, "/fixture/spicetify", "/fixture/spicetify"]
        )
        run = self.patch("run", return_value=result())
        spotify_api.dependencies()
        spotify_api.dependencies()
        self.assertEqual(
            run.call_args_list,
            [
                call("flatpak", "install", "--user", "-y", "flathub", "com.spotify.Client"),
                call("brew", "install", "spicetify-cli"),
            ],
        )
        self.assertEqual(flatpak.call_count, 2)
        self.assertEqual(binary.call_count, 3)

    def test_failed_spicetify_install_keeps_failure(self):
        self.patch("spicetify_binary", return_value=None)
        self.patch("shutil.which", return_value="brew")
        self.patch("run", side_effect=subprocess.CalledProcessError(7, ["brew"], output="failure"))
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            spotify_api.ensure_spicetify()
        self.assertEqual(failure.exception.returncode, 7)

    def test_dependency_install_requires_executable(self):
        self.patch("spicetify_binary", return_value=None)
        self.patch("shutil.which", return_value="brew")
        self.patch("run", return_value=result())
        with self.assertRaisesRegex(RuntimeError, "executable"):
            spotify_api.ensure_spicetify()

    def test_confirmation_yes_no_and_eof(self):
        tty = self.home / "tty"
        os.environ["SPOTIFI_SPOTIFY_TTY"] = str(tty)
        with redirect_stderr(io.StringIO()):
            for text, expected in (("\n", True), ("yes\n", True), ("no\n", False)):
                tty.write_text(text)
                self.assertEqual(spotify_api.confirm_close(), expected)
            tty.write_text("")
            with self.assertRaisesRegex(RuntimeError, "no interactive input"):
                spotify_api.confirm_close()
            tty.unlink()
            with self.assertRaisesRegex(RuntimeError, "no interactive input"):
                spotify_api.confirm_close()

    def test_close_mac_and_flatpak(self):
        for system in ("Darwin", "Linux"):
            with self.subTest(system=system), ExitStack() as stack:
                os.environ["SPOTIFI_PLATFORM"] = system
                stack.enter_context(
                    patch.object(spotify_api, "spotify_is_running", side_effect=[True, False])
                )
                stack.enter_context(patch.object(spotify_api, "mpris", return_value=result(1)))
                stack.enter_context(
                    patch.object(spotify_api, "flatpak_is_running", return_value=True)
                )
                stack.enter_context(
                    patch.object(spotify_api.shutil, "which", return_value="flatpak")
                )
                run = stack.enter_context(patch.object(spotify_api, "run", return_value=result()))
                spotify_api.stop_spotify()
                run.assert_called_once_with(
                    *(
                        ["osascript", "-e", 'tell application "Spotify" to quit']
                        if system == "Darwin"
                        else ["flatpak", "kill", "com.spotify.Client"]
                    )
                )

    def test_graceful_linux_quit_avoids_kill(self):
        self.patch("spotify_is_running", side_effect=[True, False])
        quit = self.patch("mpris", return_value=result())
        run = self.patch("run")
        spotify_api.stop_spotify()
        quit.assert_called_once_with("org.mpris.MediaPlayer2.Quit")
        run.assert_not_called()

    def test_native_linux_quit_fallback_and_timeout(self):
        self.patch("spotify_is_running", return_value=True)
        self.patch("mpris", return_value=result(1))
        self.patch("flatpak_is_running", return_value=False)
        run = self.patch("run", return_value=result())
        with self.assertRaisesRegex(RuntimeError, "did not stop"):
            spotify_api.stop_spotify()
        run.assert_called_once_with("pkill", "-TERM", "-f", "/spotify( |$)")

    def test_current_setup_leaves_running_spotify_untouched(self):
        self.configure_boundaries(current=True)
        spotify_api.configure()
        self.close.assert_not_called()
        self.apply.assert_not_called()
        self.open.assert_not_called()

    def test_failed_apply_reopens_and_preserves_error_status(self):
        self.configure_boundaries()
        self.apply.side_effect = subprocess.CalledProcessError(7, ["spicetify"])
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            spotify_api.configure(yes=True)
        self.assertEqual(failure.exception.returncode, 7)
        self.close.assert_called_once()
        self.open.assert_called_once_with(was_flatpak=True)

    def test_failed_repair_reopens_and_preserves_error_status(self):
        self.configure_boundaries()
        self.survives.return_value = False
        self.apply.side_effect = [None, subprocess.CalledProcessError(9, ["spicetify"])]
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            spotify_api.configure(yes=True)
        self.assertEqual(failure.exception.returncode, 9)
        self.assertEqual(self.close.call_count, 2)
        self.assertEqual(self.open.call_count, 2)

    def test_reopen_failure_does_not_mask_apply_failure(self):
        self.configure_boundaries()
        self.apply.side_effect = subprocess.CalledProcessError(7, ["spicetify"])
        self.open.side_effect = RuntimeError("cannot open")
        with (
            redirect_stderr(io.StringIO()),
            self.assertRaises(subprocess.CalledProcessError) as failure,
        ):
            spotify_api.configure(yes=True)
        self.assertEqual(failure.exception.returncode, 7)

    def test_force_reapplies_current_setup_and_closed_spotify_stays_closed(self):
        self.configure_boundaries(running=False, current=True)
        spotify_api.configure(force=True)
        self.apply.assert_called_once_with("spicetify", self.spotify, self.prefs, True)
        self.close.assert_not_called()
        self.open.assert_not_called()

    def test_declined_close_and_failed_shutdown_never_configure(self):
        self.configure_boundaries()
        self.patch("confirm_close", return_value=False)
        with self.assertRaisesRegex(RuntimeError, "Skipping"):
            spotify_api.configure()
        self.close.assert_not_called()
        with patch.object(spotify_api, "confirm_close", return_value=True):
            self.close.side_effect = RuntimeError("did not close")
            with self.assertRaisesRegex(RuntimeError, "did not close"):
                spotify_api.configure()
        self.apply.assert_not_called()

    def test_relaunch_repair_only_once(self):
        for states in ([True], [False, True], [False, False]):
            with self.subTest(states=states):
                self.configure_boundaries()
                self.survives.side_effect = states
                if states == [False, False]:
                    with self.assertRaisesRegex(
                        RuntimeError, "replaced the Spicetify bundle again"
                    ):
                        spotify_api.configure(yes=True)
                else:
                    spotify_api.configure(yes=True)
                self.assertEqual(self.apply.call_count, len(states))
                self.assertEqual(self.close.call_count, len(states))
                self.assertEqual(self.open.call_count, len(states))

    def test_relaunch_check_mac_and_linux(self):
        applied = self.patch("is_applied", return_value=False)
        self.assertTrue(spotify_api.survives_relaunch(self.spotify))
        applied.assert_not_called()
        os.environ["SPOTIFI_PLATFORM"] = "Darwin"
        self.assertFalse(spotify_api.survives_relaunch(self.spotify))
        applied.return_value = True
        os.environ["SPOTIFI_SPOTIFY_RELAUNCH_CHECKS"] = "2"
        self.assertTrue(spotify_api.survives_relaunch(self.spotify))
        self.assertEqual(applied.call_count, 3)

    def test_installs_extensions_before_apply_and_reuses_backup(self):
        self.write_config()
        self.fake_spicetify()
        spotify_api.configure_spicetify("spicetify", self.spotify, self.prefs)
        self.assertEqual(self.calls[-1], ("--no-restart", "apply"))
        for name in spotify_api.EXTENSIONS:
            self.assertIn(("config", "extensions", name), self.calls)
            self.assertTrue(spotify_api.has_extension(self.config, name))
            target = self.config.parent / "Extensions" / name
            self.assertTrue(system_api.same_file(spotify_api.EXTENSION_DIR / name, target))
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_missing_backup_uses_backup_apply(self):
        self.write_config(version="")
        self.fake_spicetify()
        original = spotify_api.run

        def no_backup(*args, **kwargs):
            if args[1:] == ("config",):
                return result()
            return original(*args, **kwargs)

        with patch.object(spotify_api, "run", side_effect=no_backup):
            spotify_api.configure_spicetify("spicetify", self.spotify, self.prefs)
        self.assertIn(("--no-restart", "backup", "apply"), self.calls)

    def test_backup_version_reads_ini_and_colored_cli_output(self):
        for text in (
            "[Backup]\nversion = 1.2.3\n",
            "\x1b[1mBackup\x1b[0m\nversion 1.2.3\n",
            "[Backup]\nversion=1.2.3",
        ):
            self.assertEqual(spotify_api.backup_version(text), "1.2.3")
        self.assertEqual(spotify_api.backup_version("[Backup]\n[Other]\nversion=bad"), "")

    def test_no_config_or_apply_writes_when_current(self):
        self.configured()
        self.fake_spicetify()
        before = {p: p.stat().st_mtime_ns for p in self.home.rglob("*") if p.is_file()}
        self.assertTrue(spotify_api.configuration_is_current("spicetify", self.spotify, self.prefs))
        spotify_api.configure_spicetify("spicetify", self.spotify, self.prefs)
        self.assertEqual(self.calls, [("-c",), ("-c",)])
        self.assertEqual(
            before, {p: p.stat().st_mtime_ns for p in self.home.rglob("*") if p.is_file()}
        )

    def test_config_paths_with_equals_and_trailing_slash(self):
        self.config.write_text(f"spotify_path = {self.spotify}/\nprefs_path = /prefs=a\n")
        self.assertTrue(spotify_api.paths_match(self.config, self.spotify, Path("/prefs=a")))

    def test_retired_extensions_disabled_and_picker_preserved_and_backed_up(self):
        self.write_config(spotify_api.RETIRED)
        for name in spotify_api.RETIRED:
            system_api.private_write(self.config.parent / "Extensions" / name, b"old picker")
        self.fake_spicetify()
        spotify_api.configure_spicetify("spicetify", self.spotify, self.prefs)
        for name in spotify_api.RETIRED:
            self.assertIn(("config", "extensions", name + "-"), self.calls)
            self.assertEqual(
                (self.config.parent / "Extensions" / name).exists(),
                name == "spotifai-quick-save.js",
            )
        self.assertEqual(
            (self.config.parent / "retired-extensions/spotifai-quick-save.js").read_bytes(),
            b"old picker",
        )

    def test_disabled_picker_is_preserved_and_does_not_trigger_reconfiguration(self):
        self.configured()
        picker = self.config.parent / "Extensions/spotifai-quick-save.js"
        system_api.private_write(picker, b"user customized picker")
        self.fake_spicetify()
        self.assertTrue(spotify_api.configuration_is_current("spicetify", self.spotify, self.prefs))
        spotify_api.configure_spicetify("spicetify", self.spotify, self.prefs)
        self.assertEqual(picker.read_bytes(), b"user customized picker")
        self.assertEqual(self.calls, [("-c",), ("-c",)])

    def test_validates_missing_and_stale_bundle_after_apply(self):
        for missing in (True, False):
            with self.subTest(missing=missing):
                self.configured()
                self.fake_spicetify()
                target = self.spotify / "Apps/xpui/extensions/play.js"
                target.unlink() if missing else target.write_text("stale")
                with (
                    patch.object(spotify_api, "apply_spicetify"),
                    self.assertRaisesRegex(
                        RuntimeError, "missing" if missing else "does not match"
                    ),
                ):
                    spotify_api.configure_spicetify(
                        "spicetify", self.spotify, self.prefs, force=True
                    )

    def test_validates_helper_and_script_tags_after_apply(self):
        for damage in ("helper", "script"):
            with self.subTest(damage=damage):
                self.configured()
                self.fake_spicetify()
                xpui = self.spotify / "Apps/xpui"
                if damage == "helper":
                    (xpui / "helper/spicetifyWrapper.js").unlink()
                else:
                    (xpui / "index.html").write_text("<body></body>")
                with (
                    patch.object(spotify_api, "apply_spicetify"),
                    self.assertRaisesRegex(RuntimeError, "helper or extension script tags"),
                ):
                    spotify_api.configure_spicetify(
                        "spicetify", self.spotify, self.prefs, force=True
                    )

    def test_stale_backup_and_restore_recovery(self):
        recoveries = [
            (['Please run "spicetify backup apply"'], [("backup", "apply")]),
            (['Please run "spicetify restore backup"'], [("restore",), ("backup", "apply")]),
            (
                ['Preprocessed data outdated. Please run "spicetify restore backup apply"'],
                [("restore",), ("backup", "apply")],
            ),
            (
                ['Please run "spicetify backup apply"', 'Please run "spicetify restore backup"'],
                [("backup", "apply"), ("restore",), ("backup", "apply")],
            ),
        ]
        for failures, expected in recoveries:
            with self.subTest(failures=failures):
                run = self.patch(
                    "run",
                    side_effect=[result(1, text) for text in failures] + [result()] * len(expected),
                )
                spotify_api.apply_spicetify("spicetify", "apply")
                self.assertEqual([c.args[2:] for c in run.call_args_list], [("apply",), *expected])

    def test_restore_failure_is_not_retried(self):
        run = self.patch(
            "run",
            side_effect=[
                result(1, 'run "spicetify restore backup"'),
                subprocess.CalledProcessError(6, ["restore"]),
            ],
        )
        with self.assertRaises(subprocess.CalledProcessError):
            spotify_api.apply_spicetify("spicetify", "apply")
        self.assertEqual(run.call_count, 2)

    def test_unbackupable_client_is_not_reinstalled(self):
        run = self.patch(
            "run", side_effect=[result(1, "Spotify cannot be backed up at this state."), result(1)]
        )
        with self.assertRaises(subprocess.CalledProcessError):
            spotify_api.apply_spicetify("spicetify", "apply")
        self.assertEqual(
            run.call_args_list,
            [
                call("spicetify", "--no-restart", "apply", check=False),
                call("spicetify", "-c", check=False),
            ],
        )

    def test_repairs_applied_bundle_without_touching_backup(self):
        self.write_config(spotify_api.EXTENSIONS, extra="sidebar_config = 1\n")
        backup = self.config.parent / "Backup/xpui.spa"
        system_api.private_write(backup, b"stale backup")
        self.install_bundle()
        xpui = self.spotify / "Apps/xpui"
        (xpui / "xpui-modules.js").write_text("Spicetify._platform = platform;")
        index = xpui / "index.html"
        index.write_text(
            '<html><body><script>Spicetify.Config={};</script><script src="extensions/custom.js"></script></body></html>'
        )
        helper = self.home / "libexec/jsHelper"
        helper.mkdir(parents=True)
        (helper / "spicetifyWrapper.js").write_text("wrapper")
        (helper / "sidebarConfig.js").write_text("sidebar")
        binary = self.home / "spicetify-bin"
        binary.touch()
        link = self.home / "spicetify-link"
        link.symlink_to(binary)
        self.assertEqual(spotify_api.helper_directory(str(link)), helper)
        run = self.patch(
            "run",
            side_effect=[
                result(1, "Spotify cannot be backed up again"),
                result(output=str(self.config)),
                result(output="2.45.1"),
            ],
        )
        spotify_api.apply_spicetify(str(link), "apply")
        self.assertEqual(run.call_count, 3)
        self.assertEqual(backup.read_bytes(), b"stale backup")
        self.assertTrue(spotify_api.is_applied(self.spotify))
        self.assertIn("helper/sidebarConfig.js", index.read_text())
        self.assertNotIn("extensions/custom.js", index.read_text())
        self.assertEqual(index.read_text().count("Spicetify.Config="), 1)

    def test_repair_rejects_stock_or_incomplete_bundle(self):
        self.install_bundle()
        apps = self.spotify / "Apps"
        self.assertFalse(spotify_api.bundle_is_applied(apps))
        (apps / "xpui/xpui.js").write_text("Spicetify.URI")
        self.assertTrue(spotify_api.bundle_is_applied(apps))
        (apps / "stock.spa").touch()
        self.assertFalse(spotify_api.bundle_is_applied(apps))

    def test_private_bridge_copies_only_credentials_and_detects_drift(self):
        os.environ["SPOTIFI_PLATFORM"] = "Darwin"
        config = {"token": "a" * 64, "port": 47683, "keys": ["m"], "bounds": [1, 2, 320]}
        system_api.private_write(settings.mini_config(), json.dumps(config).encode())
        self.assertFalse(spotify_api.mini_bridge(self.config.parent, self.spotify, check=True))
        spotify_api.mini_bridge(self.config.parent, self.spotify)
        self.assertTrue(spotify_api.mini_bridge(self.config.parent, self.spotify, check=True))
        target = self.config.parent / "Extensions/mini-bridge.json"
        self.assertEqual(json.loads(target.read_text()), {"token": "a" * 64, "port": 47683})
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        target.chmod(0o644)
        self.assertFalse(spotify_api.mini_bridge(self.config.parent, self.spotify, check=True))
        target.write_text("{}")
        self.assertFalse(spotify_api.mini_bridge(self.config.parent, self.spotify, check=True))

    def test_invalid_transport_credentials_fail_before_writes(self):
        os.environ["SPOTIFI_PLATFORM"] = "Darwin"
        invalid = [
            None,
            [],
            {},
            {"token": "x", "port": 47683},
            {"token": "a" * 64 + "\n", "port": 47683},
        ]
        invalid += [
            {"token": "a" * 64, "port": port} for port in (True, 47683.5, 1023, 65536, "47683")
        ]
        for config in invalid:
            with self.subTest(config=config):
                system_api.private_write(settings.mini_config(), json.dumps(config).encode())
                with self.assertRaisesRegex(ValueError, "credentials"):
                    spotify_api.mini_bridge(self.config.parent, self.spotify)
        self.assertFalse((self.config.parent / "Extensions").exists())

    def test_invalid_companion_config_does_not_close_spotify(self):
        self.configure_boundaries()
        os.environ["SPOTIFI_PLATFORM"] = "Darwin"
        system_api.private_write(settings.mini_config(), b"{}")
        with self.assertRaises(ValueError):
            spotify_api.configure(yes=True)
        self.close.assert_not_called()
        self.apply.assert_not_called()

    def test_failure_details_remove_color_and_status_prefixes(self):
        self.assertEqual(
            system_api.failure_details(
                "spicetify v2.45.0\n\x1b[36m info \x1b[0m Apply the config\n warning  Restore the backup"
            ),
            "spicetify v2.45.0\nApply the config\nRestore the backup",
        )


class PlaybackTests(IsolatedSpotify):
    def test_cli_opens_routes_with_selector_and_modes(self):
        opened = self.patch("open_uri")
        self.patch("sys.stdin.isatty", return_value=False)
        for args, selector, mode in (
            (["play"], "library", "sequential"),
            (["play", "180g", "--smart-shuffle"], "180g", "smart-shuffle"),
            (["play", "liked", "--shuffle"], "liked", "shuffle"),
            (["play", "playlist"], "playlist", "sequential"),
        ):
            cli_api.main(args)
            self.assertRegex(
                opened.call_args.args[0],
                "^spotify:search:spotifi-play-" + selector + "-" + mode + "-",
            )

    def test_cli_rejects_multiple_selectors_modes_and_removed_command(self):
        with redirect_stderr(io.StringIO()):
            for args in (
                ["play", "liked", "playlist"],
                ["play", "--shuffle", "--smart-shuffle"],
                ["shuffle"],
                ["mini", "unknown"],
            ):
                with self.subTest(args=args), self.assertRaises(SystemExit) as error:
                    cli_api.main(args)
                self.assertEqual(error.exception.code, 2)

    def test_declining_play_resumes_without_opening_route(self):
        self.patch("sys.stdin.isatty", return_value=True)
        self.patch("has_existing_playback", return_value=True)
        self.patch("builtins.input", return_value="no")
        resumed = self.patch("resume_playback")
        opened = self.patch("open_uri")
        cli_api.main(["play", "playlist"])
        resumed.assert_called_once()
        opened.assert_not_called()

    def test_yes_bypasses_play_confirmation(self):
        self.patch("sys.stdin.isatty", return_value=True)
        prompt = self.patch("builtins.input", side_effect=AssertionError("must not prompt"))
        self.patch("open_uri")
        cli_api.main(["play", "liked", "--yes"])
        prompt.assert_not_called()

    def test_end_of_input_resumes_existing_playback(self):
        self.patch("sys.stdin.isatty", return_value=True)
        self.patch("has_existing_playback", return_value=True)
        self.patch("builtins.input", side_effect=EOFError)
        resumed = self.patch("resume_playback")
        opened = self.patch("open_uri")
        spotify_api.play()
        resumed.assert_called_once()
        opened.assert_not_called()

    def test_native_binary_cannot_point_back_to_cli(self):
        binary = self.home / "spotify"
        binary.symlink_to(resources.PROJECT_ROOT / "bin/spotifi")
        os.environ["SPOTIFI_SPOTIFY_BINARY"] = str(binary)
        self.patch("shutil.which", return_value=None)
        self.patch("flatpak_installed", return_value=False)
        process = self.patch("subprocess.Popen")
        is_file = Path.is_file
        with patch.object(
            Path,
            "is_file",
            lambda path: (
                False
                if str(path) in ("/usr/bin/spotify", "/usr/local/bin/spotify")
                else is_file(path)
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "not installed"):
                spotify_api.open_spotify()
        process.assert_not_called()

    def test_installed_cli_cannot_be_used_as_spotify_binary(self):
        binary = self.home / "spotifi-installed"
        binary.write_text("fixture")
        binary.chmod(0o700)
        os.environ["SPOTIFI_SPOTIFY_BINARY"] = str(binary)
        self.patch("shutil.which", return_value=None)
        self.patch("flatpak_installed", return_value=False)
        process = self.patch("subprocess.Popen")
        is_file = Path.is_file
        with (
            patch.object(sys, "argv", [str(binary)]),
            patch.object(
                Path,
                "is_file",
                lambda path: (
                    False
                    if str(path) in ("/usr/bin/spotify", "/usr/local/bin/spotify")
                    else is_file(path)
                ),
            ),
            self.assertRaisesRegex(RuntimeError, "not installed"),
        ):
            spotify_api.open_spotify()
        process.assert_not_called()

    def test_metadata_or_queue_indicates_existing_playback(self):
        for metadata, queue, expected in (
            ("({'mpris:trackid': <'track'>},)", "", True),
            ("({},)", "(<true>,)", True),
            ("({},)", "(<false>,)", False),
        ):
            with patch.object(
                spotify_api,
                "mpris_property",
                side_effect=lambda name: metadata if name == "Metadata" else queue,
            ):
                self.assertEqual(spotify_api.has_existing_playback(), expected)

    def test_resume_paused_context_plays_and_waits_for_confirmation(self):
        self.patch("playback_status", side_effect=["Paused", "Paused", "Playing"])
        self.patch("has_existing_playback", return_value=True)
        mpris = self.patch("mpris", return_value=result())
        spotify_api.resume_playback()
        mpris.assert_called_once_with("org.mpris.MediaPlayer2.Player.Play")

    def test_unknown_context_cannot_resume(self):
        self.patch("playback_status", return_value=None)
        mpris = self.patch("mpris")
        with self.assertRaisesRegex(RuntimeError, "no playback context"):
            spotify_api.resume_playback()
        mpris.assert_not_called()

    def test_running_uri_uses_mpris_and_cold_start_opens_first(self):
        self.patch("playback_status", return_value="Playing")
        opened = self.patch("open_spotify")
        mpris = self.patch("mpris", return_value=result())
        spotify_api.open_uri("spotify:test")
        opened.assert_not_called()
        mpris.assert_called_once_with("org.mpris.MediaPlayer2.Player.OpenUri", "spotify:test")
        events = []
        with (
            patch.object(spotify_api, "playback_status", return_value=None),
            patch.object(spotify_api, "open_spotify", side_effect=lambda: events.append("open")),
        ):
            mpris.side_effect = lambda *args: events.append("route") or result()
            spotify_api.open_uri("spotify:test")
        self.assertEqual(events, ["open", "route"])

    def test_failed_uri_is_not_silently_successful(self):
        self.patch("playback_status", return_value="Playing")
        self.patch("mpris", return_value=result(1))
        with self.assertRaisesRegex(RuntimeError, "Could not open"):
            spotify_api.open_uri("spotify:test")

    def test_open_linux_flatpak_and_native_with_literal_uri(self):
        self.patch("flatpak_installed", return_value=True)
        process = self.patch("subprocess.Popen")
        uri = "spotify:search:a;$(touch nope)"
        spotify_api.open_spotify(uri)
        self.assertEqual(
            process.call_args.args[0], ["flatpak", "run", "com.spotify.Client", "--uri=" + uri]
        )
        binary = self.home / "spotify-bin"
        binary.write_text("fixture")
        binary.chmod(0o700)
        os.environ["SPOTIFI_SPOTIFY_BINARY"] = str(binary)
        with patch.object(spotify_api, "flatpak_installed", return_value=False):
            spotify_api.open_spotify(uri)
        self.assertEqual(process.call_args.args[0], [str(binary), "--uri=" + uri])

    def test_mpris_argument_list_and_missing_tool(self):
        self.patch("shutil.which", return_value="gdbus")
        run = self.patch("run", return_value=result(output="(<'Playing'>,)"))
        self.assertEqual(spotify_api.playback_status(), "Playing")
        self.assertEqual(
            run.call_args.args[-3:],
            (
                "org.freedesktop.DBus.Properties.Get",
                "org.mpris.MediaPlayer2.Player",
                "PlaybackStatus",
            ),
        )
        with patch.object(spotify_api.shutil, "which", return_value=None):
            self.assertIsNone(spotify_api.playback_status())

    def test_reopen_preserves_native_backend_when_flatpak_is_also_installed(self):
        binary = self.home / "spotify-native"
        binary.write_text("fixture")
        binary.chmod(0o700)
        os.environ["SPOTIFI_SPOTIFY_BINARY"] = str(binary)
        self.patch("flatpak_installed", return_value=True)
        process = self.patch("subprocess.Popen")
        spotify_api.open_spotify(was_flatpak=False)
        self.assertEqual(process.call_args.args[0], [str(binary)])
        spotify_api.open_spotify(was_flatpak=True)
        self.assertEqual(process.call_args.args[0], ["flatpak", "run", "com.spotify.Client"])

    def test_apply_forces_configuration_then_reloads_mini(self):
        configure = self.patch("configure")
        reload = self.patch("mini_reload")
        cli_api.main(["apply"])
        configure.assert_called_once_with(force=True, yes=True)
        reload.assert_called_once()

    def test_cli_help_from_other_directory_and_invalid_command_exit(self):
        cli = resources.PROJECT_ROOT / "bin/spotifi"
        for args, code in ((["--help"], 0), (["shuffle"], 2), (["play", "liked", "playlist"], 2)):
            command = subprocess.run(
                [sys.executable, str(cli), *args], cwd=self.home, capture_output=True, text=True
            )
            self.assertEqual(command.returncode, code, command.stderr)
        self.assertIn(
            "usage: spotifi",
            subprocess.run(
                [sys.executable, str(cli), "--help"], capture_output=True, text=True
            ).stdout,
        )


class MiniTests(IsolatedSpotify):
    def current_binary(self):
        binary = settings.mini_binary()
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"previous binary")
        binary.chmod(0o700)
        source_hash = settings.mini_directory() / "source.sha256"
        source_hash.write_text(
            hashlib.sha256((resources.ROOT / "src/mini-player.swift").read_bytes()).hexdigest()
        )
        return binary, source_hash

    def test_prepare_repairs_metadata_without_rebuilding(self):
        binary, _ = self.current_binary()
        run = self.patch("run", return_value=result())
        self.assertTrue(mini_api.mini_prepare())
        before = binary.read_bytes()
        self.assertFalse(mini_api.mini_prepare())
        self.assertEqual(
            run.call_args_list,
            [call(binary, "--self-test"), call(binary, "--validate-config", settings.mini_config())]
            * 2,
        )
        self.assertEqual(binary.read_bytes(), before)
        self.assertEqual(settings.mini_config().stat().st_mode & 0o777, 0o600)
        self.assertEqual(settings.mini_directory().stat().st_mode & 0o777, 0o700)
        info = plistlib.loads((binary.parent.parent / "Info.plist").read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], settings.MINI_ID)

    def test_failed_candidate_preserves_binary_and_source_hash(self):
        binary, source_hash = self.current_binary()
        source_hash.write_text("previous")
        candidate = binary.with_suffix(".new")

        def process(*args, **kwargs):
            if args[0] == "xcrun":
                candidate.write_bytes(b"new binary")
                return result()
            raise subprocess.CalledProcessError(8, args)

        self.patch("run", side_effect=process)
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            mini_api.mini_prepare()
        self.assertEqual(failure.exception.returncode, 8)
        self.assertEqual(binary.read_bytes(), b"previous binary")
        self.assertEqual(source_hash.read_text(), "previous")
        self.assertFalse(candidate.exists())

    def test_install_current_agent_does_not_restart(self):
        self.patch("mini_prepare", return_value=False)
        self.patch("configure")
        run = self.patch("run", return_value=result())
        mini_api.mini_install()
        before = settings.mini_agent().stat().st_mtime_ns
        run.reset_mock()
        mini_api.mini_install()
        self.assertEqual(settings.mini_agent().stat().st_mtime_ns, before)
        run.assert_called_once_with(
            "launchctl", "print", f"gui/{os.getuid()}/{settings.MINI_ID}", check=False
        )

    def test_reload_installed_manual_stopped_and_disabled(self):
        os.environ["SPOTIFI_PLATFORM"] = "Darwin"
        system_api.private_write(settings.mini_config(), b"{}")
        prepare = self.patch("mini_prepare")
        stop = self.patch("mini_stop")
        run = self.patch("run", return_value=result())
        settings.mini_agent().parent.mkdir(parents=True)
        settings.mini_agent().touch()
        mini_api.mini_reload()
        self.assertEqual(run.call_args.args[:2], ("launchctl", "bootstrap"))
        stop.assert_called_once()
        settings.mini_agent().unlink()
        stop.reset_mock()
        mini_api.mini_reload()
        self.assertEqual(run.call_args.args[:2], ("open", "-a"))
        stop.assert_called_once()
        run.return_value = result(1)
        run.reset_mock()
        stop.reset_mock()
        mini_api.mini_reload()
        self.assertEqual(run.call_count, 1)
        stop.assert_not_called()
        settings.mini_config().unlink()
        prepare.reset_mock()
        run.reset_mock()
        mini_api.mini_reload()
        prepare.assert_not_called()
        run.assert_not_called()

    def test_uninstall_retains_and_prepare_restores_preferences(self):
        self.write_config()
        system_api.private_write(
            settings.mini_config(), json.dumps({"token": "a" * 64, "port": 47683}).encode()
        )
        settings.mini_agent().parent.mkdir(parents=True)
        settings.mini_agent().touch()
        for path in (
            self.config.parent / "Extensions/mini-bridge.json",
            self.spotify / "Apps/xpui/extensions/mini-bridge.json",
        ):
            system_api.private_write(path, b"{}")
        self.patch("spicetify_binary", return_value="spicetify")
        self.patch("mini_stop")
        self.patch("run", return_value=result(output=str(self.config)))
        mini_api.mini_uninstall()
        self.assertFalse(settings.mini_agent().exists())
        self.assertFalse(settings.mini_config().exists())
        self.assertFalse((self.config.parent / "Extensions/mini-bridge.json").exists())
        self.current_binary()
        with patch.object(mini_api, "run", return_value=result()):
            mini_api.mini_prepare()
        self.assertEqual(json.loads(settings.mini_config().read_text())["token"], "a" * 64)

    def test_linux_native_tasks_skip_without_side_effects(self):
        prepare = self.patch("mini_prepare")
        for task in ("mini", "build-mini", "test-mini"):
            tasks.task(task)
        prepare.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "requires macOS"):
            cli_api.main(["mini"])

    def test_task_runner_invokes_python_and_expands_node_tests(self):
        process = self.patch("subprocess.run", return_value=result())
        tasks.task("test")
        node, python = [c.args[0] for c in process.call_args_list]
        self.assertEqual(node[:2], ["node", "--test"])
        self.assertTrue(all("*" not in value for value in node))
        self.assertEqual(python[:4], [sys.executable, "-m", "unittest", "discover"])

    def test_task_failures_exit_with_one_line_instead_of_traceback(self):
        for error, code, message in (
            (RuntimeError("Close it first."), 1, "spotifi: Close it first.\n"),
            (
                subprocess.CalledProcessError(7, ["brew"], output=" error  brew failed"),
                7,
                "spotifi: brew failed\n",
            ),
        ):
            with self.subTest(error=error):
                self.patch("dependencies", side_effect=error)
                stderr = io.StringIO()
                with redirect_stderr(stderr), self.assertRaises(SystemExit) as exit:
                    tasks.task("dependencies")
                self.assertEqual(exit.exception.code, code)
                self.assertEqual(stderr.getvalue(), message)


if __name__ == "__main__":
    unittest.main()
