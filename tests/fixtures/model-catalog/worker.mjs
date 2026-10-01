// Public metadata fixture only: no HTTP client or credentials are used.
import { PublicPiModelCatalog } from "../../../src/runtime/pi/public-model-catalog.mjs";
import { createPiModels } from "../../../src/runtime/pi/model-catalog.mjs";
const [root, id] = process.argv.slice(2);
let release;
const catalog = new PublicPiModelCatalog({ environment: { MOONDOG_CONFIG_HOME: root }, timeoutMs: 10_000,
  fetchImpl: async () => {
    process.send({ event: "fetch" });
    await new Promise(resolve => { release = resolve; });
    const model = { ...createPiModels().getModel("deepseek", "deepseek-flash"), id, name: "Fictional process model" };
    return Response.json({ [id]: model });
  } });
await catalog.ready;
process.on("message", message => { if (message === "release") release?.(); });
process.send({ event: "ready" });
await new Promise(resolve => process.once("message", resolve));
try {
  const result = await catalog.refresh({ provider: "deepseek", force: true });
  process.send({ event: "done", result, ids: catalog.models("deepseek").map(model => model.id) });
} catch (error) { process.send({ event: "error", name: error.name }); }
process.disconnect();
