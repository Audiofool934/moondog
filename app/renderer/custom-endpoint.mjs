import { make, turning } from "./ui.mjs";

export function createCustomEndpointSettings({ send, locale, changed }) {
  let configured = false;
  let loaded = false;
  let busy = false;
  let notice = "";
  let failed = false;
  const fields = { baseUrl: "", modelId: "", apiKey: "", protocol: "openai-completions", contextWindow: 128000, maxTokens: 4096 };
  const zh = () => String(locale()).startsWith("zh");
  const say = (chinese, english) => zh() ? chinese : english;
  function receive(message) {
    if (message.type !== "custom-endpoint") return;
    busy = message.stage === "loading";
    failed = message.stage === "error";
    notice = failed ? message.message : message.action === "test" && message.stage === "done" ? say("连接成功，模型已返回有效响应。", "Connected. The model returned a valid response.") : "";
    if (message.stage === "done" && message.endpoint) {
      configured = message.endpoint.configured;
      if (!loaded || ["save", "remove"].includes(message.action)) {
        for (const key of Object.keys(fields)) if (key !== "apiKey" && message.endpoint[key] !== undefined) fields[key] = message.endpoint[key];
        fields.apiKey = ""; loaded = true;
        if (message.action === "remove") { fields.baseUrl = ""; fields.modelId = ""; }
      }
      if (message.action === "save") notice = say("已保存并切换到自定义接口。", "Saved and switched to the custom API.");
    }
    changed();
  }
  function render() {
    const root = make("section", "custom-endpoint");
    root.append(make("h3", "", say("自定义 API / 中转站", "Custom API / Gateway")),
      make("p", "note", say("填写服务商提供的 API 地址和模型 ID。密钥只保存在本机，留空可保留原地址的已存密钥。", "Enter your gateway's API base URL and model ID. Keys stay on this machine. Leave the key blank to keep it for the same URL.")));
    const form = make("form", "custom-endpoint-form");
    const controls = {};
    for (const [key, label, type, placeholder] of [
      ["baseUrl", say("API 地址", "API base URL"), "url", "https://gateway.example/v1"],
      ["apiKey", "API Key", "password", configured ? say("已保存；留空保持不变", "Saved; leave blank to keep") : "API Key"],
      ["modelId", say("模型 ID", "Model ID"), "text", say("填写中转站实际提供的模型 ID", "Exact model ID from your gateway")],
      ["contextWindow", say("上下文 token 上限", "Context token limit"), "number", "128000"],
      ["maxTokens", say("最大输出 token", "Max output tokens"), "number", "4096"],
    ]) {
      const labelNode = make("label"); labelNode.append(make("span", "", label));
      const input = make("input", "text-field"); input.type = type; input.placeholder = placeholder;
      input.dataset.key = `custom:${key}`; input.value = fields[key]; input.autocomplete = key === "apiKey" ? "new-password" : "off";
      input.addEventListener("input", () => { fields[key] = input.value; });
      if (type === "number") { input.min = key === "maxTokens" ? "16" : "1024"; input.step = "1"; }
      if (key !== "apiKey" || !configured) input.required = true;
      labelNode.append(input); form.append(labelNode); controls[key] = input;
    }
    const label = make("label"); label.append(make("span", "", say("API 协议", "API protocol")));
    const protocol = make("select", "text-field"); protocol.dataset.key = "custom:protocol";
    for (const [id, name] of [["openai-completions", "OpenAI Chat Completions"], ["openai-responses", "OpenAI Responses"], ["anthropic-messages", "Anthropic Messages"]]) {
      const option = make("option", "", name); option.value = id; protocol.append(option);
    }
    protocol.value = fields.protocol;
    protocol.addEventListener("change", () => { fields.protocol = protocol.value; }); label.append(protocol); form.append(label);
    const actions = make("div", "netease-actions");
    const button = (text, key, action) => {
      const node = make("button", "button quiet small", text); node.type = "button"; node.dataset.key = `custom:${key}`; node.disabled = busy;
      if (action) node.addEventListener("click", action); return node;
    };
    const save = button(say("保存并使用", "Save and use"), "save"); save.type = "submit"; save.className = "button primary";
    actions.append(save);
    const test = button(say("测试连接", "Test connection"), "test", () => send({ type: "custom-endpoint-test" })); test.disabled = busy || !configured;
    actions.append(test);
    if (configured) actions.append(button(say("移除配置", "Remove"), "remove", () => send({ type: "custom-endpoint-remove" })));
    if (busy) actions.append(turning());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      send({ type: "custom-endpoint-save", endpoint: { ...fields } });
      fields.apiKey = ""; controls.apiKey.value = "";
    });
    form.append(actions); root.append(form);
    if (notice) { const message = make("p", "note", notice); message.setAttribute("role", failed ? "alert" : "status"); root.append(message); }
    return root;
  }
  return { render, receive, refresh: () => send({ type: "custom-endpoint-status" }) };
}
