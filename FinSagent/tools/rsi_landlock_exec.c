/* Execute an RSI candidate with an allow-listed Landlock filesystem view. */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <linux/prctl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stdio.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

static int create_ruleset(const struct landlock_ruleset_attr *attr, size_t size, __u32 flags) {
    return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}
static int add_rule(int fd, enum landlock_rule_type type, const void *attr, __u32 flags) {
    return syscall(__NR_landlock_add_rule, fd, type, attr, flags);
}
static int restrict_self(int fd, __u32 flags) {
    return syscall(__NR_landlock_restrict_self, fd, flags);
}

static void die(const char *message) {
    perror(message);
    exit(126);
}

#define DENY_SYSCALL(name) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##name, 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

static void install_seccomp(void) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        DENY_SYSCALL(socket),
        DENY_SYSCALL(socketpair),
        DENY_SYSCALL(connect),
        DENY_SYSCALL(bind),
        DENY_SYSCALL(listen),
        DENY_SYSCALL(accept),
        DENY_SYSCALL(accept4),
        DENY_SYSCALL(sendto),
        DENY_SYSCALL(sendmsg),
        DENY_SYSCALL(sendmmsg),
        DENY_SYSCALL(recvfrom),
        DENY_SYSCALL(recvmsg),
        DENY_SYSCALL(recvmmsg),
        DENY_SYSCALL(ptrace),
        DENY_SYSCALL(process_vm_readv),
        DENY_SYSCALL(process_vm_writev),
        DENY_SYSCALL(mount),
        DENY_SYSCALL(umount2),
        DENY_SYSCALL(unshare),
        DENY_SYSCALL(setns),
        DENY_SYSCALL(bpf),
        DENY_SYSCALL(perf_event_open),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0)
        die("PR_SET_SECCOMP");
}

static void allow_path(int ruleset_fd, const char *path, __u64 access) {
    int path_fd = open(path, O_PATH | O_CLOEXEC);
    if (path_fd < 0) {
        fprintf(stderr, "rsi-landlock: cannot open allow-listed path %s: %s\n", path, strerror(errno));
        exit(126);
    }
    struct stat path_stat;
    if (fstat(path_fd, &path_stat) < 0) die("fstat allow-listed path");
    if (!S_ISDIR(path_stat.st_mode)) {
        access &= LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
                  LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
    }
    struct landlock_path_beneath_attr rule = {
        .allowed_access = access,
        .parent_fd = path_fd,
    };
    if (add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0)
        die("landlock_add_rule");
    close(path_fd);
}

int main(int argc, char **argv) {
    int abi = create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 1) die("landlock ABI unavailable");

    __u64 read_access = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
                        LANDLOCK_ACCESS_FS_READ_DIR;
    __u64 write_access = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
                         LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |
                         LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
                         LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
                         LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;
    if (abi >= 2) write_access |= LANDLOCK_ACCESS_FS_REFER;
    if (abi >= 3) write_access |= LANDLOCK_ACCESS_FS_TRUNCATE;
    __u64 handled = read_access | write_access;
    struct landlock_ruleset_attr ruleset = {.handled_access_fs = handled};
    int ruleset_fd = create_ruleset(&ruleset, sizeof(ruleset), 0);
    if (ruleset_fd < 0) die("landlock_create_ruleset");

    int separator = -1;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--")) { separator = i; break; }
        if (i + 1 >= argc) { fprintf(stderr, "usage: %s [--read PATH|--write PATH] -- COMMAND...\n", argv[0]); return 2; }
        if (!strcmp(argv[i], "--read")) allow_path(ruleset_fd, argv[++i], read_access);
        else if (!strcmp(argv[i], "--write")) allow_path(ruleset_fd, argv[++i], handled);
        else { fprintf(stderr, "rsi-landlock: unknown option %s\n", argv[i]); return 2; }
    }
    if (separator < 0 || separator + 1 >= argc) {
        fprintf(stderr, "usage: %s [--read PATH|--write PATH] -- COMMAND...\n", argv[0]);
        return 2;
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die("PR_SET_NO_NEW_PRIVS");
    if (restrict_self(ruleset_fd, 0) < 0) die("landlock_restrict_self");
    close(ruleset_fd);
    install_seccomp();
    execvp(argv[separator + 1], &argv[separator + 1]);
    die("execvp");
}
