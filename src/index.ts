import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"

const POKE_CMD = "poke.subagent"
const POKE_TITLE = "Poke subagent"
const POKE_DESC = "Abort a stuck subagent and optionally send it a message"
const POLL_INTERVAL = 500
const POLL_TIMEOUT = 5000

type SubagentInfo = {
  id: string
  title: string
  status: string
}

async function getActiveSubagents(api: TuiPluginApi, parentSessionID: string): Promise<SubagentInfo[]> {
  const res = await api.client.session.children({ sessionID: parentSessionID }).catch(() => null)
  if (!res?.data) return []

  const statusMap = new Map<string, string>()
  const statuses = await api.client.session.status().catch(() => null)
  if (statuses?.data) {
    for (const [id, status] of Object.entries(statuses.data)) {
      statusMap.set(id, status.type)
    }
  }

  return res.data.map((child) => ({
    id: child.id,
    title: child.title ?? child.id.slice(0, 12),
    status: statusMap.get(child.id) ?? "unknown",
  }))
}

async function waitForIdle(api: TuiPluginApi, sessionID: string): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT) {
    const statuses = await api.client.session.status().catch(() => null)
    if (statuses?.data) {
      const status = statuses.data[sessionID]
      if (!status || status.type === "idle") return true
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL))
  }
  return false
}

async function pokeSubagent(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session" || !route.params) {
    api.ui.toast({ variant: "warning", message: "No active session" })
    return
  }

  const sessionID = route.params.sessionID as string
  const subagents = await getActiveSubagents(api, sessionID)

  if (subagents.length === 0) {
    api.ui.toast({ variant: "info", message: "No subagents found for this session" })
    return
  }

  const statusIcon = (s: string) => {
    if (s === "busy") return "\u25cf"
    if (s === "idle") return "\u25cb"
    if (s === "retry") return "\u25d4"
    return "?"
  }

  const options = subagents.map((s) => ({
    title: `${statusIcon(s.status)} ${s.title}`,
    value: s,
    description: `${s.status} \u2014 ${s.id.slice(0, 16)}`,
  }))

  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Poke subagent",
      options,
      onSelect(option) {
        api.ui.dialog.clear()
        showAction(api, sessionID, option.value)
      },
    }),
  )
}

function showAction(api: TuiPluginApi, parentSessionID: string, subagent: SubagentInfo) {
  const actions = [
    {
      title: "Abort",
      value: "abort" as const,
      description: "Stop the subagent \u2014 parent will see it as failed and can retry",
    },
    {
      title: "Abort + send message",
      value: "message" as const,
      description: "Stop the subagent, then send it a message to continue with new instructions",
    },
    {
      title: "Abort + poke parent",
      value: "parent" as const,
      description: "Stop the subagent and tell the parent to retry the task",
    },
  ]

  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `Action for: ${subagent.title}`,
      options: actions,
      onSelect(option) {
        api.ui.dialog.clear()
        if (option.value === "abort") doAbort(api, subagent)
        else if (option.value === "message") doAbortAndMessage(api, subagent)
        else if (option.value === "parent") doAbortAndPokeParent(api, parentSessionID, subagent)
      },
    }),
  )
}

async function doAbort(api: TuiPluginApi, subagent: SubagentInfo) {
  await api.client.session.abort({ sessionID: subagent.id }).catch(() => null)
  api.ui.toast({ variant: "success", message: `Aborted: ${subagent.title}` })
}

async function doAbortAndMessage(api: TuiPluginApi, subagent: SubagentInfo) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Message for subagent",
      placeholder: "e.g. You were stuck. Summarize what you found and return.",
      onConfirm: async (text) => {
        api.ui.dialog.clear()
        await api.client.session.abort({ sessionID: subagent.id }).catch(() => null)
        const idle = await waitForIdle(api, subagent.id)
        if (!idle) {
          api.ui.toast({ variant: "warning", message: "Subagent didn't go idle after abort \u2014 message may not deliver" })
        }
        await api.client.session
          .prompt({
            sessionID: subagent.id,
            parts: [{ type: "text", text }],
          })
          .catch(() => null)
        api.ui.toast({ variant: "success", message: `Poked: ${subagent.title}` })
      },
      onCancel() {
        api.ui.dialog.clear()
      },
    }),
  )
}

async function doAbortAndPokeParent(api: TuiPluginApi, parentSessionID: string, subagent: SubagentInfo) {
  await api.client.session.abort({ sessionID: subagent.id }).catch(() => null)
  const idle = await waitForIdle(api, parentSessionID)
  if (!idle) {
    api.ui.toast({ variant: "warning", message: "Parent didn't go idle \u2014 message may not deliver" })
  }
  await api.client.session
    .prompt({
      sessionID: parentSessionID,
      parts: [
        {
          type: "text",
          text: `The subagent "${subagent.title}" (${subagent.id}) was stuck and has been manually aborted. Please retry the task it was working on.`,
        },
      ],
    })
    .catch(() => null)
  api.ui.toast({ variant: "success", message: `Aborted subagent and poked parent` })
}

export const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: POKE_CMD,
        title: POKE_TITLE,
        desc: POKE_DESC,
        category: "Plugin",
        namespace: "palette",
        slashName: "poke",
        run() {
          pokeSubagent(api)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("poke.global", [POKE_CMD]),
  })
}
