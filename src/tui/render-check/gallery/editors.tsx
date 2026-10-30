import { describeSettings } from "../../../core/configschema.js";
import { HandoffModelsEditor } from "../../features/settings/handoffmodels.js";
import { ListEditor } from "../../features/settings/listeditor.js";
import { McpAccessEditor } from "../../features/settings/mcpaccess.js";
import { WebOrderEditor } from "../../features/settings/weborder.js";
import { CONFIGURED } from "./settings.js";
import { Stage, type GalleryEntry } from "./registry.js";

/**
 * The settings editors that open from a row of the settings page, each drawn
 * on its own with fixed rows. (`settings.tsx` reaches the same editors by
 * driving the whole page; these show a state without the walk.)
 */

const noop = (): void => {};
const WIDTH = 100;
const HEIGHT = 14;

const listView = (needle: string) => {
  const view = describeSettings(CONFIGURED).find((entry) => entry.descriptor.kind.type === "list" && entry.descriptor.key.includes(needle));
  if (view === undefined) throw new Error(`no list setting with "${needle}" in its key`);
  return view;
};

const list = (id: string, title: string, needle: string): GalleryEntry => ({
  id,
  group: "settings",
  title,
  width: WIDTH,
  height: HEIGHT,
  settleMs: 150,
  element: () => {
    const view = listView(needle);
    return (
      <Stage width={WIDTH} height={HEIGHT}>
        <ListEditor
          descriptor={view.descriptor}
          items={view.items ?? []}
          screen={{ profile: null, model: null }}
          onScreen={noop}
          heading={null}
          onHeading={noop}
          saving={null}
          onSet={noop}
          onDuplicate={noop}
          run={null}
          onTest={noop}
          onProbe={noop}
          onDiscover={async () => ({ ok: true, host: "localhost:11434", models: [{ id: "qwen3-coder:30b", contextWindow: 131_072 }] })}
          onExport={noop}
          onImport={noop}
          notice={null}
          width={WIDTH}
          onExit={noop}
        />
      </Stage>
    );
  },
});

const MODELS = [
  { slug: "claude-opus-5", name: "Claude Opus 5", offered: true, handoff: "auto", handoffAt: 400_000, compaction: null, compactAt: null },
  { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", offered: true, handoff: null, handoffAt: null, compaction: null, compactAt: null },
  { slug: "claude-retired-3", name: "Claude Retired 3", offered: false, handoff: "off", handoffAt: null, compaction: null, compactAt: null },
];

export const EDITOR_GALLERY: GalleryEntry[] = [
  list("list-editor-profiles", "ListEditor: Harness profiles", "profiles"),
  list("list-editor-mcp", "ListEditor: MCP servers", "mcp"),
  {
    id: "mcp-access-editor",
    group: "settings",
    title: "McpAccessEditor",
    width: WIDTH,
    height: 16,
    element: () => (
      <Stage width={WIDTH} height={16}>
        <McpAccessEditor
          title="MCP servers"
          description="Which servers Claude gets. A tick is applied at once."
          servers={[
            { name: "brave-search", summary: "npx · stdio", locked: null },
            { name: "exa", summary: "https://mcp.exa.ai/mcp", locked: null },
            { name: "github", summary: "https://api.githubcopilot.com/mcp/", locked: null },
            { name: "filesystem", summary: "npx · stdio", locked: "Switched off for every provider" },
            { name: "moxen", summary: "built in", locked: "Always on" },
          ]}
          excluded={["exa"]}
          width={WIDTH}
          onChange={noop}
          onExit={noop}
        />
      </Stage>
    ),
  },
  {
    id: "web-order-editor",
    group: "settings",
    title: "WebOrderEditor",
    width: WIDTH,
    height: 16,
    element: () => (
      <Stage width={WIDTH} height={16}>
        <WebOrderEditor
          title="Web search"
          description="The tools the model tries, in this order."
          rows={[
            { id: "brave", label: "Brave Search", summary: "brave-search MCP server", locked: null, rank: 1 },
            { id: "native", label: "Provider's own", summary: "Claude's built-in search", locked: null, rank: 2 },
            { id: "exa", label: "Exa", summary: "exa MCP server", locked: null, rank: null },
            { id: "harness", label: "Moxen's", summary: "needs the Harness enabled", locked: "The Harness is off", rank: null },
          ]}
          width={WIDTH}
          onChange={noop}
          onExit={noop}
        />
      </Stage>
    ),
  },
  {
    id: "handoff-models-editor",
    group: "settings",
    title: "HandoffModelsEditor",
    width: WIDTH,
    height: 18,
    element: () => (
      <Stage width={WIDTH} height={18}>
        <HandoffModelsEditor
          title="Per model"
          description="Long-thread behaviour for one model; blank follows the provider."
          models={MODELS}
          compaction={{ choices: [{ value: "auto", label: "Automatic" }, { value: "off", label: "Off" }], unavailable: null }}
          width={WIDTH}
          catalogReady
          onChange={noop}
          onExit={noop}
        />
      </Stage>
    ),
  },
];
