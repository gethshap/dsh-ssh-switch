# DSH SSH 工作区

在同一个 DeepSeek Harness Web 窗口打开本地项目和 SSH 项目。会话、模型请求和设置留在本机。远程会话的 `bash`、`read`、`write`、`edit`、`glob`、`grep` 在 SSH 主机上执行。远端无需安装 DSH、Node.js 或本插件。

本地使用 DSH Web `0.2.1-rc.2`、Node.js 22.19 或 24+ 和 OpenSSH 客户端。远端使用 Linux 或 macOS，且非交互式 SSH 环境能找到 `python3`。搜索需要远端 `rg`，命令需要远端 `bash`。在 DSH 的 `read-only` 或 `workspace-write` 权限模式下执行 Bash，需要 Linux 上支持 `--disable-userns` 的 `bwrap` 和 `libseccomp`。这两种模式限制 Bash 直接写入的目录，并禁用套接字连接。沙箱不可用时命令会失败。明确选择 `danger-full-access` 时，Bash 按 SSH 账号权限执行。文本文件工具仍限制在已登记的目录内。

## 安装

从 [GitHub Releases](https://github.com/gethshap/dsh-ssh-switch/releases) 下载 `.tgz`。也可以在源码目录运行 `npm pack`。然后从插件包所在目录安装。

```sh
dsh plugin --profile web add ./dsh-ssh-switch-0.1.0.tgz -w
dsh --profile web
```

在本机的 `~/.ssh/config` 配置一个别名。端口、跳板机和密钥由 OpenSSH 配置管理。插件使用非交互式登录和严格主机密钥校验。

```sshconfig
Host devbox
    HostName devbox.example.com
    User developer
    IdentityFile ~/.ssh/id_ed25519
```

先在终端确认主机指纹和 SSH 登录，再测试非交互式连接：

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes devbox 'python3 --version'
```

在 DSH 侧栏底部打开 **SSH 工作区**，填写名称、SSH 别名和远端绝对路径，例如 `/srv/my-project`。**添加**会先检查目录，再把它登记为原生 DSH 工作区并打开会话。通过侧栏点选另一个本地或远程会话即可切换。重开远程会话会继续使用该工作区原来的 SSH 目标。

## 当前范围

- DSH 侧栏的工作区路径是本机登记目录，远程文件不会同步到本机。Agent 的工作区上下文会显示实际的 SSH 别名和目录。远程会话只允许执行上述六种模型工具，DSH 仍可能显示预设自带的子代理工具，其调用会被拒绝。侧栏文件树和 GUI 终端仍使用本地环境，后台作业、图片读取和本机 MCP 工具未接入 SSH。
- 每个工具请求使用一次非交互 SSH 调用。Bash 从远程工作目录启动，最多运行 90 秒。命令之间不共享 shell 状态。丢失连接后工具报错，写操作不会自动重试。
- 文本读写最多 2 MiB，搜索和命令返回有长度上限。文件工具不穿越符号链接，修改使用同目录原子替换。执行权限仍受 SSH 账号限制。
- 绑定记录保存在 `$DSH_HOME/ssh-switch/workspaces.json`，默认 `DSH_HOME` 是 `~/.dsh`。保留插件和绑定记录以恢复已有远程会话。

## 调研

[dsh-cloud-workspaces](https://github.com/harryopo/dsh-cloud-workspaces) 用会话内工具替换实现免部署远程工作区。[dsh-remote-development](https://github.com/CJYLZS/dsh-remote-development) 在文件系统和子进程服务层路由。[dsh-remote-workspace](https://github.com/lengmoXXL/dsh-remote-workspace) 使用通过 SSH 启动的辅助程序。本插件保留 DSH 的原生工作区和会话导航，使用本机 OpenSSH 与随每次请求发送的短生命周期 Python 程序。
