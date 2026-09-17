import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CUSTOM_PORT = "17881";

function composeConfig(args, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    LIVEKIT_URL: "ws://localhost:7880",
    LIVEKIT_API_KEY: "placeholder-key",
    LIVEKIT_API_SECRET: "placeholder-secret-not-for-production",
    ...extraEnv,
  };
  const out = execFileSync(
    "docker",
    ["compose", "--env-file", "/dev/null", ...args, "config", "--no-env-resolution", "--format", "json"],
    { cwd: new URL("..", import.meta.url).pathname, env, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function livekitPorts(cfg) {
  return cfg.services.livekit.ports
    .filter((p) => p.protocol === "tcp" && p.target !== 7880)
    .map((p) => `${p.published}:${p.target}`);
}

function tcpEnv(cfg) {
  return cfg.services.livekit.environment.LIVEKIT_RTC_TCP_PORT;
}

const base = ["-f", "docker-compose.yml"];
const cases = [
  ["base overlay", base],
  ["base+noproxy overlay", [...base, "-f", "docker-compose.noproxy.yml"]],
  ["base+local overlay", [...base, "-f", "docker-compose.local.yml"]],
  ["dev overlay", ["-f", "docker-compose.dev.yml"]],
];

describe("LiveKit RTC TCP port chain", () => {
  describe("defaults (7881) across compose overlays", () => {
    for (const [name, args] of cases) {
      it(`${name}: env pass-through and port mapping agree`, () => {
        const cfg = composeConfig(args);
        expect(tcpEnv(cfg)).toBe("7881");
        expect(livekitPorts(cfg)).toEqual(["7881:7881"]);
      });
    }
  });

  it("custom LIVEKIT_RTC_TCP_PORT propagates to mapping and env", () => {
    const cfg = composeConfig(base, { LIVEKIT_RTC_TCP_PORT: CUSTOM_PORT });
    expect(tcpEnv(cfg)).toBe(CUSTOM_PORT);
    expect(livekitPorts(cfg)).toEqual([`${CUSTOM_PORT}:${CUSTOM_PORT}`]);
  });

  it("custom port stays consistent through the noproxy overlay", () => {
    const cfg = composeConfig([...base, "-f", "docker-compose.noproxy.yml"], {
      LIVEKIT_RTC_TCP_PORT: CUSTOM_PORT,
    });
    expect(tcpEnv(cfg)).toBe(CUSTOM_PORT);
    expect(livekitPorts(cfg)).toEqual([`${CUSTOM_PORT}:${CUSTOM_PORT}`]);
  });
});

describe("livekit-entrypoint.sh renders rtc.tcp_port from env", () => {
  const script = new URL("../deploy/livekit-entrypoint.sh", import.meta.url).pathname;
  const generated = (env) => {
    const path = `/tmp/opencode/livekit-config-${crypto.randomUUID()}.yaml`;
    const { status } = spawnSync("sh", [script], {
      env: {
        PATH: process.env.PATH,
        LIVEKIT_API_KEY: "placeholder-key",
        LIVEKIT_API_SECRET: "placeholder-secret-not-for-production",
        LIVEKIT_CONFIG_PATH: path,
        ...env,
      },
    });
    expect([0, 127], "config write must succeed (127 = /livekit-server absent on host)").toContain(status);
    return path;
  };
  it("defaults to 7881", () => {
    const path = generated({});
    expect(readFileSync(path, "utf8")).toMatch(/^  tcp_port: 7881$/m);
  });

  it("honors LIVEKIT_RTC_TCP_PORT", () => {
    const path = generated({ LIVEKIT_RTC_TCP_PORT: CUSTOM_PORT });
    expect(readFileSync(path, "utf8")).toMatch(
      new RegExp(`^  tcp_port: ${CUSTOM_PORT}$`, "m"),
    );
  });
});
