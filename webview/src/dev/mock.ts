// Development only: plays the extension host so the panel can be designed in a browser
// with `npm run dev`. Pick a starting screen with ?state=idle|running|done|error|empty
// and a theme with ?theme=dark|light.
import type { HostMessage, PanelState, WebviewMessage } from "@shared/protocol"
import { DEV_MESSAGE_EVENT } from "@/lib/vscode"

const params = new URLSearchParams(location.search)

const THEMES = {
  dark: {
    "--vscode-sideBar-background": "#181818",
    "--vscode-foreground": "#cccccc",
    "--vscode-editor-background": "#1f1f1f",
    "--vscode-editor-foreground": "#cccccc",
    "--vscode-editorWidget-background": "#202020",
    "--vscode-button-background": "#0078d4",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-secondaryBackground": "#313131",
    "--vscode-button-secondaryForeground": "#cccccc",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-list-hoverBackground": "#2a2d2e",
    "--vscode-errorForeground": "#f85149",
    "--vscode-widget-border": "#313131",
    "--vscode-focusBorder": "#0078d4",
    "--vscode-textLink-foreground": "#4daafc",
  },
  light: {
    "--vscode-sideBar-background": "#f8f8f8",
    "--vscode-foreground": "#3b3b3b",
    "--vscode-editor-background": "#ffffff",
    "--vscode-editor-foreground": "#3b3b3b",
    "--vscode-editorWidget-background": "#f8f8f8",
    "--vscode-button-background": "#005fb8",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-secondaryBackground": "#e5e5e5",
    "--vscode-button-secondaryForeground": "#3b3b3b",
    "--vscode-descriptionForeground": "#6b6b6b",
    "--vscode-list-hoverBackground": "#f2f2f2",
    "--vscode-errorForeground": "#f85149",
    "--vscode-widget-border": "#e5e5e5",
    "--vscode-focusBorder": "#005fb8",
    "--vscode-textLink-foreground": "#005fb8",
  },
}

const theme = params.get("theme") === "light" ? "light" : "dark"
for (const [name, value] of Object.entries(THEMES[theme])) {
  document.documentElement.style.setProperty(name, value)
}
document.documentElement.style.setProperty("--vscode-font-family", '"Segoe UI", system-ui, sans-serif')
document.documentElement.style.setProperty("--vscode-editor-font-family", "Consolas, monospace")
document.body.classList.add(`vscode-${theme}`)

const file = { uri: "file:///demo/src/cart.ts", displayPath: "src/cart.ts", fileName: "cart.ts", languageId: "typescript" }

const base: PanelState = {
  file,
  status: "idle",
  stale: false,
  truncated: false,
  methods: [],
  storyPending: false,
  usageSearchPending: false,
  purposePending: false,
  provider: "claude",
  mode: "manual",
}

const done: PanelState = {
  ...base,
  status: "done",
  summary: {
    oneLine: "장바구니에 담긴 물건들의 값을 계산해 주는 계산원이에요.",
    story:
      "이 파일은 가게 계산대에 서 있는 계산원 같아요. 손님이 바구니에 물건을 담으면 하나하나 값을 더하고, 할인 쿠폰이 있으면 그만큼 깎아 준 다음, 마지막에 내야 할 돈을 알려 줘요.",
    keyPoints: ["물건 값을 모두 더해요", "쿠폰이 있으면 값을 깎아 줘요", "빈 바구니면 0원을 알려 줘요"],
  },
  methods: [
    {
      id: "m1",
      name: "calculateTotal",
      container: "Cart",
      line: 12,
      character: 2,
      explanation: {
        role: "바구니에 담긴 모든 물건의 값을 더해 주는 일을 맡았어요.",
        story:
          "calculateTotal은 바구니를 들여다보며 물건을 하나씩 꺼내요. 물건마다 붙은 가격표를 보고, 몇 개를 샀는지 곱해서 공책에 적어요. 마지막 물건까지 다 적으면 공책의 숫자를 모두 더해서 알려 줘요.",
        steps: ["바구니가 비었는지 먼저 살펴봐요", "물건마다 가격과 개수를 곱해요", "모두 더한 값을 돌려줘요"],
      },
      usages: [
        {
          id: "u1",
          uri: "file:///demo/src/checkout.ts",
          displayPath: "src/checkout.ts",
          line: 41,
          character: 20,
          caller: "submitOrder",
          preview: "const total = cart.calculateTotal();",
          purpose: "주문을 보내기 전에 손님이 내야 할 돈이 얼마인지 알아보려고 불러요.",
        },
        {
          id: "u2",
          uri: "file:///demo/src/components/CartSummary.tsx",
          displayPath: "src/components/CartSummary.tsx",
          line: 17,
          character: 22,
          caller: "CartSummary",
          preview: "<span>{cart.calculateTotal()}</span>",
          purpose: "화면에 합계 금액을 보여 주려고 불러요.",
        },
      ],
      usageTotal: 5,
    },
    {
      id: "m2",
      name: "applyCoupon",
      container: "Cart",
      line: 30,
      character: 2,
      explanation: {
        role: "쿠폰을 받아서 값을 깎아 주는 일을 맡았어요.",
        story: "applyCoupon은 손님이 내민 쿠폰을 살펴보고, 쓸 수 있는 쿠폰이면 적힌 만큼 값을 깎아 줘요.",
        steps: ["쿠폰이 아직 쓸 수 있는지 확인해요", "깎아 줄 금액을 계산해요"],
      },
      usages: [],
      usageTotal: 0,
    },
  ],
}

const running: PanelState = {
  ...done,
  status: "running",
  stage: "writing",
  summary: undefined,
  storyPending: true,
  usageSearchPending: true,
  methods: done.methods.map((method) => ({ ...method, explanation: undefined, usages: [], usageTotal: 0 })),
}

const purposePending: PanelState = {
  ...done,
  status: "running",
  stage: "writing",
  purposePending: true,
  methods: done.methods.map((method) => ({
    ...method,
    usages: method.usages.map((usage) => ({ ...usage, purpose: undefined })),
  })),
}

const SCREENS: Record<string, PanelState> = {
  idle: base,
  running,
  purposes: purposePending,
  done,
  stale: { ...done, stale: true, truncated: true },
  error: {
    ...base,
    status: "error",
    error: {
      kind: "cli-not-found",
      message: "Claude CLI를 찾지 못했어요. 설치되어 있는지, 설정의 실행 파일 경로가 맞는지 확인해 주세요.",
      detail: "claude: spawn claude ENOENT",
    },
  },
  empty: { ...base, file: undefined },
}

let timers: number[] = []

function post(state: PanelState) {
  const message: HostMessage = { type: "state", state }
  window.postMessage(message, "*")
}

function play() {
  timers.forEach(clearTimeout)
  post({ ...running, stage: "symbols", methods: [] })
  timers = [
    window.setTimeout(() => post(running), 800),
    window.setTimeout(() => post(purposePending), 3000),
    window.setTimeout(() => post(done), 5000),
  ]
}

window.addEventListener(DEV_MESSAGE_EVENT, (event) => {
  const message = (event as CustomEvent<WebviewMessage>).detail
  switch (message.type) {
    case "ready":
      post(SCREENS[params.get("state") ?? "idle"] ?? base)
      break
    case "explain":
      play()
      break
    case "cancel":
      timers.forEach(clearTimeout)
      post(base)
      break
    default:
      console.log("[mock host]", message)
  }
})
