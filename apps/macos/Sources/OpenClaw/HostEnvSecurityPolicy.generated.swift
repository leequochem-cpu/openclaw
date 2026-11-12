// Generated file. Do not edit directly.
// Source: src/infra/host-env-security-policy.json
// Regenerate: node scripts/generate-host-env-security-policy-swift.mjs --write

import Foundation

enum HostEnvSecurityPolicy {
    static let blockedKeys: Set<String> = [
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "PERL5LIB",
        "PERL5OPT",
        "RUBYLIB",
        "RUBYOPT",
        "BASH_ENV",
        "ENV",
        "GIT_EXTERNAL_DIFF",
        "SHELL",
        "SHELLOPTS",
        "PS4",
        "GCONV_PATH",
        "IFS",
        "SSLKEYLOGFILE"
    ]

    static let blockedOverrideKeys: Set<String> = [
        "HOME",
        "ZDOTDIR",
        "GIT_SSH_COMMAND",
        "GIT_SSH",
        "GIT_PROXY_COMMAND",
        "GIT_ASKPASS",
        "SSH_ASKPASS",
        "LESSOPEN",
        "LESSCLOSE",
        "PAGER",
        "MANPAGER",
        "GIT_PAGER",
        "EDITOR",
        "VISUAL",
        "FCEDIT",
        "SUDO_EDITOR",
        "PROMPT_COMMAND",
        "HISTFILE",
        "PERL5DB",
        "PERL5DBCMD",
        "OPENSSL_CONF",
        "OPENSSL_ENGINES",
        "PYTHONSTARTUP",
        "WGETRC",
        "CURL_HOME",
        "CLASSPATH",
        "CGO_CFLAGS",
        "CGO_LDFLAGS",
        "CORECLR_PROFILER_PATH",
        "PHPRC",
        "PHP_INI_SCAN_DIR",
        "DENO_DIR",
        "BUN_CONFIG_REGISTRY",
        "LUA_PATH",
        "LUA_CPATH",
        "GEM_HOME",
        "GEM_PATH",
        "BUNDLE_GEMFILE",
        "COMPOSER_HOME",
        "XDG_CONFIG_HOME"
    ]

    static let blockedOverridePrefixes: [String] = [
        "GIT_CONFIG_",
        "NPM_CONFIG_"
    ]

    static let blockedPrefixes: [String] = [
        "DYLD_",
        "LD_",
        "BASH_FUNC_"
    ]
}
