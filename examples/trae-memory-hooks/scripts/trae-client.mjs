export function resolveTraeClient(env = process.env, argv = process.argv) {
  const channel = String(env.TRAE_CONFIG_CHANNEL || "").toLowerCase();
  if (channel.includes("trae-cn")) return "trae-cn";
  if (channel.includes("trae")) return "trae";
  const requested = env.OPENVIKING_HOOK_SOURCE || argv[2];
  return requested === "trae-cn" ? "trae-cn" : "trae";
}
