"""One request over SSH stdio. Runs with the remote SSH account."""

import ctypes
import ctypes.util
import errno
import fcntl
import json
import os
import secrets
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager

FILE_CAP = 2 * 1024 * 1024
OUTPUT_CAP = 48 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def coordinates(root, path):
    if not isinstance(path, str) or not path or "\x00" in path or len(path) > 4096:
        raise ValueError("Invalid remote path.")
    target = os.path.normpath(path if path.startswith("/") else os.path.join(root, path))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("Path is outside the remote workspace.")
    rel = os.path.relpath(target, root)
    return [] if rel == "." else rel.split("/")


@contextmanager
def directory(root, parts):
    root_parts = root.strip("/").split("/") if root != "/" else []
    fd = os.open("/", DIR_FLAGS)
    try:
        for part in root_parts + parts:
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


def read_file(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("Expected a regular text file.")
        data = source.read(FILE_CAP + 1)
    if len(data) > FILE_CAP:
        raise ValueError("File exceeds the 2 MiB text limit. Use a remote shell command to read a smaller range.")
    if b"\0" in data:
        raise ValueError("Expected UTF-8 text.")
    return data.decode("utf-8"), info


def replace_file(parent, name, content, info):
    data = content.encode("utf-8")
    if len(data) > FILE_CAP or b"\0" in data:
        raise ValueError("Expected UTF-8 text within the 2 MiB limit.")
    temp = ".dsh-ssh-" + secrets.token_hex(16)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666, dir_fd=parent)
    try:
        with os.fdopen(fd, "wb") as output:
            if info is not None:
                os.fchmod(output.fileno(), info.st_mode & 0o777)
            output.write(data)
        if info is None:
            os.link(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
        else:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (current.st_ino, current.st_dev, current.st_ctime_ns) != (info.st_ino, info.st_dev, info.st_ctime_ns):
                raise ValueError("File changed during the operation. Read it again.")
            os.replace(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        try:
            os.unlink(temp, dir_fd=parent)
        except FileNotFoundError:
            pass


def file_operation(root, op, args, mode):
    parts = coordinates(root, args["file_path"])
    if not parts:
        raise ValueError("Expected a file, got the workspace directory.")
    name = parts[-1]
    with directory(root, parts[:-1]) as parent:
        if op == "read":
            text, _ = read_file(parent, name)
            lines = text.splitlines()
            start, limit = args.get("offset", 1), args.get("limit", 200)
            if not isinstance(start, int) or not isinstance(limit, int) or start < 1 or not 1 <= limit <= 2000:
                raise ValueError("offset must be positive and limit must be between 1 and 2000.")
            numbered = "\n".join(f"{i}: {line[:4000]}" for i, line in enumerate(lines[start-1:start-1+limit], start))
            return f"{args['file_path']} ({len(lines)} lines)\n{numbered}"
        if mode not in ("workspace-write", "danger-full-access"):
            raise ValueError("The current DSH sandbox mode is read-only.")
        try:
            fcntl.flock(parent, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("Another SSH tool is editing this directory. Retry the operation.") from exc
        try:
            current, info = read_file(parent, name)
        except FileNotFoundError:
            if op == "edit":
                raise
            current, info = "", None
        if op == "write":
            content = args["content"]
        else:
            old, new = args["old_string"], args["new_string"]
            count = current.count(old) if old else 0
            if count == 0 or (count > 1 and not args.get("replace_all", False)):
                raise ValueError("Expected one literal match. Re-read the file or set replace_all.")
            replacement_size = len(current.encode("utf-8")) + count * (
                len(new.encode("utf-8")) - len(old.encode("utf-8"))
            )
            if replacement_size > FILE_CAP:
                raise ValueError("The edit would exceed the 2 MiB text limit.")
            content = current.replace(old, new, -1 if args.get("replace_all", False) else 1)
        replace_file(parent, name, content, info)
        return f"{'Created' if info is None else 'Updated'} {args['file_path']}"


def command(argv, root, timeout, pass_fds=()):
    output = bytearray()
    truncated = False
    process = subprocess.Popen(argv, cwd=root, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True, pass_fds=pass_fds)
    deadline = time.monotonic() + timeout
    completed = False
    try:
        with selectors.DefaultSelector() as streams:
            streams.register(process.stdout, selectors.EVENT_READ)
            streams.register(sys.stdin, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("Remote command exceeded its time limit.")
                if len(streams.get_map()) == 1 and process.poll() is not None:
                    completed = True
                    return process.returncode, output.decode("utf-8", errors="replace") + (
                        "\n[output truncated]" if truncated else ""
                    )
                for key, _ in streams.select(min(remaining, 0.1)):
                    if key.fileobj == sys.stdin:
                        raise ValueError("SSH request was disconnected.")
                    data = os.read(key.fd, 8192)
                    if not data:
                        streams.unregister(key.fileobj)
                        continue
                    left = OUTPUT_CAP - len(output)
                    output.extend(data[:left])
                    truncated |= len(data) > left
    finally:
        if not completed:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        process.stdout.close()


def export_socket_filter(fd):
    # The read-only mount does not protect host sockets. The child only
    # inherits pipes, and cannot open sockets or submit socket I/O via io_uring.
    library = ctypes.util.find_library("seccomp")
    if not library:
        raise ValueError("Restricted remote Bash requires libseccomp on Linux.")
    seccomp = ctypes.CDLL(library)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    allow, deny = 0x7FFF0000, 0x00050000 | errno.EPERM
    filter_context = seccomp.seccomp_init(allow)
    if not filter_context:
        raise ValueError("Could not initialize the remote shell socket filter.")
    try:
        socket_calls = [seccomp.seccomp_syscall_resolve_name(name) for name in (b"socket", b"socketcall")]
        socket_calls = [number for number in socket_calls if number >= 0]
        io_uring = seccomp.seccomp_syscall_resolve_name(b"io_uring_setup")
        if not socket_calls or io_uring < 0:
            raise ValueError("The remote libseccomp does not support this shell socket filter.")
        for number in [*socket_calls, io_uring]:
            if seccomp.seccomp_rule_add(filter_context, deny, number, 0) != 0:
                raise ValueError("Could not build the remote shell socket filter.")
        if seccomp.seccomp_export_bpf(filter_context, fd) != 0:
            raise ValueError("Could not export the remote shell socket filter.")
        os.lseek(fd, 0, os.SEEK_SET)
    finally:
        seccomp.seccomp_release(filter_context)


def shell_command(root, script, mode):
    shell = shutil.which("bash")
    if not shell:
        raise ValueError("bash is required for remote shell commands.")
    argv = [shell, "-c", script]
    if mode == "danger-full-access":
        return command(argv, root, 90)
    bwrap = shutil.which("bwrap")
    if not bwrap or sys.platform != "linux":
        raise ValueError("Remote shell confinement requires bubblewrap (bwrap) on Linux.")
    if root == "/" and mode == "workspace-write":
        raise ValueError("Use a project directory instead of / for workspace-write shell confinement.")
    mounts = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]
    if mode == "workspace-write":
        mounts += ["--bind", root, root]
    with tempfile.TemporaryFile() as socket_filter:
        fd = socket_filter.fileno()
        export_socket_filter(fd)
        return command([
            bwrap, "--unshare-all", "--disable-userns", "--new-session", "--die-with-parent",
            "--cap-drop", "ALL", "--seccomp", str(fd), *mounts, "--chdir", root, "--", *argv,
        ], root, 90, (fd,))


def run(request):
    root = os.path.realpath(request["root"])
    if not os.path.isdir(root):
        raise ValueError("The SSH workspace directory does not exist.")
    op = request["op"]
    if op == "probe":
        return root
    if root != request["root"]:
        raise ValueError("The remote workspace location changed. Register the directory again.")
    args = request["args"]
    mode = request["mode"]
    if mode not in ("read-only", "workspace-write", "danger-full-access"):
        raise ValueError("Unknown DSH sandbox mode.")
    if op in ("read", "write", "edit"):
        return file_operation(root, op, args, mode)
    if op == "bash":
        code, output = shell_command(root, args["command"], mode)
        return f"Remote exit code: {code}\n{output}"
    if op in ("glob", "grep"):
        rg = shutil.which("rg")
        if not rg:
            raise ValueError("Install ripgrep (rg) on the SSH host to use glob and grep.")
        parts = coordinates(root, args.get("path", "."))
        target = os.path.join(root, *parts)
        if os.path.realpath(target) != target:
            raise ValueError("Search paths cannot traverse symbolic links.")
        argv = [rg, "--no-config", "--color", "never"]
        if op == "glob":
            argv += ["--files", "--hidden", "--no-ignore", "-g", "!.git", "-g", args["pattern"]]
        else:
            argv += ["--line-number", "--with-filename", "--no-heading", "--max-columns", "4000"]
            if "include" in args:
                argv += ["-g", args["include"]]
            argv += ["-e", args["pattern"]]
        code, output = command([*argv, "--", target], root, 20)
        if code not in (0, 1):
            raise ValueError(output or f"rg exited with code {code}.")
        return output or "No matches."
    raise ValueError("Unsupported SSH workspace operation.")


try:
    result = run(json.loads(sys.stdin.buffer.readline(14 * 1024 * 1024)))
    encoded = result.encode("utf-8")
    if len(encoded) > OUTPUT_CAP:
        result = encoded[:OUTPUT_CAP].decode("utf-8", errors="ignore") + "\n[output truncated]"
    response = {"value": result}
except (KeyError, OSError, ValueError, TypeError, subprocess.SubprocessError) as exc:
    response = {"error": str(exc)[:4096]}
print(json.dumps(response, ensure_ascii=True), flush=True)
