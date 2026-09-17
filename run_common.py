"""Shared plumbing for the double-clickable run_*.py scripts.

    Each of them runs a node driver in this repo, echoes its output while appending it to a
    timestamped log in experiments/logs/, and opens that log when the run is done. The log's
    first line is one short environment header: minute resolution (no seconds), the node
    version, and the OS with the CPU architecture - never a model name (AGENTS.md, "tests").

    Nothing here is specific to one driver, so the scripts themselves stay a screen long.
"""
import os
import platform
import shutil
import subprocess
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def setup():
    """Force UTF-8 on the way out: the tests print '·' and '✓', and neither a Windows console
    opened by a double-click nor a redirected file is UTF-8 by default - an encoding error must
    not be how a test run ends."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')


def stamp(when=None):
    """'2026-09-15 01:34' - not to the second: a capture's seconds are noise."""
    return (when or datetime.now()).strftime('%Y-%m-%d %H:%M')


def file_stamp(when=None):
    """'2026-09-15-01-34' - the same stamp where a filename cannot take ':' or ' '."""
    return (when or datetime.now()).strftime('%Y-%m-%d-%H-%M')


def node_version():
    """'22.22.3', or 'unknown' - never a full build string."""
    try:
        return subprocess.run(['node', '--version'], capture_output=True, text=True,
                              check=True).stdout.strip().lstrip('v')
    except (OSError, subprocess.CalledProcessError):
        return 'unknown'


def platform_line():
    """'linux x86_64' / 'mac arm64' / 'win x86_64' - the OS and CPU type, not the model."""
    os_name = {'Linux': 'linux', 'Darwin': 'mac', 'Windows': 'win'}.get(
        platform.system(), platform.system().lower())
    arch = {'x86_64': 'x86_64', 'AMD64': 'x86_64', 'arm64': 'arm64', 'aarch64': 'arm64'}.get(
        platform.machine(), platform.machine().lower())
    return os_name + ' ' + arch


def host_line():
    """The header's second half: 'node 22.22.3 · linux x86_64'."""
    return 'node ' + node_version() + ' · ' + platform_line()


def node():
    """The node executable. A missing node is the one failure a double-click cannot show in a
    scrollback, so it says what to install instead of raising FileNotFoundError."""
    exe = shutil.which('node')
    if exe:
        return exe
    fail('node was not found on PATH. Install node 22 or newer (https://nodejs.org) and run this file again.')


def log_path(name, when=None):
    """experiments/logs/<name>-<2026-09-15-01-34>.log, with the directory created."""
    directory = ROOT / 'experiments' / 'logs'
    directory.mkdir(parents=True, exist_ok=True)
    return directory / (name + '-' + file_stamp(when) + '.log')


def run(cmd, log, header):
    """Run cmd from the repo root with its output echoed and appended to log. Returns the exit
    code (130 when interrupted). The header is written first, so the log is self-describing even
    when the driver dies before its own first line."""
    print(header, flush=True)
    started = time.monotonic()
    with open(log, 'w', encoding='utf-8', errors='replace') as handle:
        handle.write(header + '\n')
        handle.flush()
        # encoding='utf-8': node writes UTF-8 regardless of the Windows codepage, and
        # text=True alone would decode it with the locale (cp1251 on a Russian Windows),
        # turning every '·' and 'ω' in the log into 'В·' and 'П‰'.
        proc = subprocess.Popen([str(part) for part in cmd], cwd=str(ROOT),
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding='utf-8', errors='replace', bufsize=1)
        code = 130
        try:
            for line in proc.stdout:
                print(line, end='', flush=True)
                handle.write(line)
            code = proc.wait()
        except KeyboardInterrupt:
            proc.terminate()
            proc.wait()
            print('\ninterrupted', flush=True)
            handle.write('interrupted\n')
        handle.write('exit ' + str(code) + ' · ' + str(int(time.monotonic() - started)) + ' s\n')
    return code


def fail(message):
    """Report a reason this script cannot run, hold the window open and exit."""
    print('\n' + message)
    hold()
    sys.exit(1)


def finish(log, code):
    """Land the run: name the log, open it, and hold the window open when it failed."""
    print('\nlog: ' + str(log))
    if code:
        print('the run failed (exit ' + str(code) + ') - the log carries the whole output')
        hold()
    else:
        open_path(log)
    return code


def open_path(path):
    """Open the log in whatever the OS uses for a text file, so a double-click ends with the
    result on screen instead of a window that closed."""
    try:
        if sys.platform.startswith('win'):
            os.startfile(str(path))
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', str(path)])
        elif shutil.which('xdg-open'):
            subprocess.Popen(['xdg-open', str(path)], stderr=subprocess.DEVNULL)
        else:
            webbrowser.open(path.as_uri())
    except OSError as error:
        print('could not open the log (' + str(error) + ')')


def hold():
    """Stop a double-clicked window from vanishing; a pipe (an agent, a CI) is not held."""
    if not sys.stdin.isatty():
        return
    try:
        input('\npress Enter to close')
    except (EOFError, KeyboardInterrupt):
        pass
