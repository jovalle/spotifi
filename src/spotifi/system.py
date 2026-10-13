"""Process execution and atomic file operations."""

import os
import platform
import re
import subprocess
import tempfile


def run(*args, check=True):
    result = subprocess.run(
        [str(arg) for arg in args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    if check and result.returncode:
        raise subprocess.CalledProcessError(result.returncode, result.args, output=result.stdout)
    return result


def current_platform():
    return os.environ.get("SPOTIFI_PLATFORM", platform.system())


def private_write(path, data):
    atomic_write(path, data)
    path.chmod(0o600)


def same_file(source, destination):
    try:
        return source.read_bytes() == destination.read_bytes()
    except FileNotFoundError:
        return False


def failure_details(output):
    output = re.sub(r"\x1b\[[0-9;]*m", "", output)
    return re.sub(r"^\s*(?:success|info|warning|error)\s+", "", output, flags=re.M).strip()


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
