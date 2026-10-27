// Settings → Sandbox: status and scope of OS-level isolation for local MCP processes.

import { api, el } from "./core.ts";
import { group, row, title, toggle } from "./ui.ts";

export async function sandboxPage(): Promise<HTMLElement[]> {
  const settings = await api<{ name: string; value?: string }[]>("/api/settings");
  const enabled = settings.find((setting) => setting.name === "VAK_SANDBOX_ENABLED")?.value !== "false";
  const note = el("p", { className: "row-hint" });
  let control: HTMLElement;
  control = toggle(enabled, async (on) => {
    const input = control as HTMLInputElement;
    input.disabled = true;
    note.textContent = "";
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ values: { VAK_SANDBOX_ENABLED: String(on) } }) });
      note.textContent = "Saved. Restart the app for this change to take effect.";
    } catch (err) {
      input.checked = !on;
      note.textContent = (err as Error).message;
    } finally {
      input.disabled = false;
    }
  });
  return [
    ...title("Sandbox", "OS-level process isolation for local MCP servers."),
    group(
      "Protection",
      row("OS-level isolation", "Use vaksb to contain local stdio MCP servers. Changes take effect after restarting the app.", control),
      row("Network", "Blocked by default inside the sandbox."),
      row("Files", "Access is limited by the sandbox policy; writes are restricted to its temporary area."),
      row("Environment", "Only the variables declared for a server are passed to it."),
      note,
    ),
    group("Tools and permissions", el("p", { className: "row-hint", textContent: "Sandbox is a system capability and provides no MCP tools of its own. Use each server’s MCP page to inspect its tools and set Allow, Ask or Off policies. The current sandbox API does not expose individual filesystem or network permission controls." })),
    group(
      "Availability",
      el("p", { className: "row-hint", textContent: "The app uses the bundled vaksb helper in release builds. In development, it looks for vaksb in the adjacent sandbox build or on PATH. If the helper is unavailable, MCP servers continue without OS-level isolation." }),
      el("a", { className: "link", href: "https://github.com/nranjan2code/sandbox", target: "_blank", rel: "noreferrer", textContent: "Sandbox project and installation details ↗" }),
    ),
  ];
}
