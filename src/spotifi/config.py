"""Private companion settings and paths."""

import json
import os
import re
from pathlib import Path

MINI_ID = "com.jovalle.spotifi.mini"


def mini_directory():
    return Path(
        os.environ.get("SPOTIFI_MINI_DIR", Path.home() / "Library/Application Support/spotifi")
    )


def mini_config():
    return Path(os.environ.get("SPOTIFI_MINI_CONFIG", mini_directory() / "config.json"))


def load_mini_config():
    config = json.loads(mini_config().read_text())
    if (
        not isinstance(config, dict)
        or not isinstance(config.get("token"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", config["token"])
        or type(config.get("port")) is not int
        or not 1024 <= config["port"] <= 65535
    ):
        raise ValueError("Invalid companion transport credentials.")
    return config


def mini_binary():
    return mini_directory() / "Mini Player.app/Contents/MacOS/mini"


def mini_agent():
    return Path.home() / "Library/LaunchAgents" / (MINI_ID + ".plist")
