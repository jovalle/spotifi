"""Terminal output: step headers, spinners, progress bars and prompts that degrade to plain text."""

import contextlib
import itertools
import os
import sys
import threading

FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


def interactive():
    return sys.stderr.isatty() and os.environ.get("TERM", "dumb") != "dumb"


def style(text, code):
    if not interactive() or "NO_COLOR" in os.environ:
        return text
    return f"\x1b[{code}m{text}\x1b[0m"


def step(title):
    print(style("▸ " + title, "1") if interactive() else title, flush=True)


def _line(symbol, code, message, stream=None):
    stream = stream or sys.stdout
    print(f"{style(symbol, code)} {message}" if interactive() else message, file=stream, flush=True)


def ok(message):
    _line("✓", "32", message)


def skip(message):
    _line("–", "2", message)


def warn(message):
    _line("!", "33", message, sys.stderr)


def fail(message):
    _line("✗", "31", message, sys.stderr)


@contextlib.contextmanager
def spinner(message):
    """Animate on a terminal while the body runs; silent otherwise."""
    if not interactive():
        yield
        return
    done = threading.Event()

    def render():
        for frame in itertools.cycle(FRAMES):
            sys.stderr.write(f"\r\x1b[2K{style(frame, '36')} {message}")
            sys.stderr.flush()
            if done.wait(0.08):
                break
        sys.stderr.write("\r\x1b[2K")
        sys.stderr.flush()

    thread = threading.Thread(target=render, daemon=True)
    thread.start()
    try:
        yield
    finally:
        done.set()
        thread.join()


def progress(items, label):
    """Yield items while drawing a progress bar on a terminal."""
    items = list(items)
    total = len(items)
    for index, item in enumerate(items, 1):
        yield item
        if interactive() and total:
            filled = round(24 * index / total)
            bar = style("█" * filled, "36") + style("░" * (24 - filled), "2")
            sys.stderr.write(f"\r\x1b[2K{bar} {index}/{total} {label}")
            sys.stderr.flush()
    if interactive() and total:
        sys.stderr.write("\r\x1b[2K")
        sys.stderr.flush()


def confirm(question, default=True):
    """Ask on the terminal; return the default without prompting when input is not interactive."""
    if os.environ.get("SPOTIFI_ASSUME_YES") == "1" or not sys.stdin.isatty():
        return default
    hint = "[Y/n]" if default else "[y/N]"
    try:
        answer = input(f"{style('?', '36')} {question} {style(hint, '2')} ")
    except EOFError:
        return default
    answer = answer.strip().lower()
    return default if not answer else answer in ("y", "yes")
