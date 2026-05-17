import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"

const POKE_CMD = "poke.session"
const POKE_TITLE = "Poke"
const POKE_DESC = "Abort a stuck agent or subagent and optionally send it a message"
const POLL_INTERVAL = 500
const POLL_TIMEOUT = 5000

type SessionInfo = {
  id: string
  title: string
  status: string
  isChild: boolean
}

async function getStatusMap(api: TuiPluginApi): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const res = await api.client.session.status().catch(() => null)
  if (res?.data) {
    for (const [id, status] of Object.entries(res.data)) {
      map.set(id, status.type)
    }
  }
  return map
}

async function findBusySessions(api: TuiPluginApi, parentSessionID: string): Promise<SessionInfo[]> {
  const statusMap = await getStatusMap(api)
  const busy: SessionInfo[] = []

  // check children first
  const children = await api.client.session.children({ sessionID: parentSessionID }).catch(() => null)
  if (children?.data) {
    for (const child of children.data) {
      const st = statusMap.get(child.id) ?? "unknown"
      if (st === "busy" || st === "retry") {
        busy.push({
          id: child.id,
          title: child.title ?? child.id.slice(0, 12),
          status: st,
          isChild: true,
        })
      }
    }
  }

  // if no busy children, check the parent itself
  if (busy.length === 0) {
    const parentStatus = statusMap.get(parentSessionID) ?? "unknown"
    if (parentStatus === "busy" || parentStatus === "retry") {
      const parentSession = await api.client.session.get({ sessionID: parentSessionID }).catch(() => null)
      busy.push({
        id: parentSessionID,
        title: parentSession?.data?.title ?? "Main session",
        status: parentStatus,
        isChild: false,
      })
    }
  }

  return busy
}

async function waitForIdle(api: TuiPluginApi, sessionID: string): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT) {
    const statusMap = await getStatusMap(api)
    const status = statusMap.get(sessionID)
    if (!status || status === "idle") return true
    await new Promise((r) => setTimeout(r, POLL_INTERVAL))
  }
  return false
}

async function poke(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session" || !route.params) {
    api.ui.toast({ variant: "warning", message: "No active session" })
    return
  }

  const sessionID = route.params.sessionID as string
  const busy = await findBusySessions(api, sessionID)

  if (busy.length === 0) {
    api.ui.toast({ variant: "info", message: "Nothing appears stuck" })
    return
  }

  // single busy session — go straight to action picker
  if (busy.length === 1) {
    showAction(api, sessionID, busy[0])
    return
  }

  // multiple busy sessions — let user pick
  const options = busy.map((s) => ({
    title: `${s.isChild ? "subagent" : "main"}: ${s.title}`,
    value: s,
    description: `${s.status} \u2014 ${s.id.slice(0, 16)}`,
  }))

  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Poke which session?",
      options,
      onSelect(option) {
        api.ui.dialog.clear()
        showAction(api, sessionID, option.value)
      },
    }),
  )
}

type Action = "abort" | "message" | "parent"

function showAction(api: TuiPluginApi, parentSessionID: string, target: SessionInfo) {
  const label = target.isChild ? "subagent" : "session"

  const actions: Array<{ title: string; value: Action; description: string }> = [
    {
      title: "Abort",
      value: "abort",
      description: `Stop the ${label}`,
    },
    {
      title: "Abort + send message",
      value: "message",
      description: `Stop the ${label}, then send it a message to continue`,
    },
  ]

  // only offer "poke parent" for subagents
  if (target.isChild) {
    actions.push({
      title: "Abort + poke parent",
      value: "parent",
      description: "Stop the subagent and tell the parent to retry",
    })
  }

  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `Poke: ${target.title}`,
      options: actions,
      onSelect(option) {
        api.ui.dialog.clear()
        if (option.value === "abort") doAbort(api, target)
        else if (option.value === "message") doAbortAndMessage(api, target)
        else if (option.value === "parent") doAbortAndPokeParent(api, parentSessionID, target)
      },
    }),
  )
}

async function doAbort(api: TuiPluginApi, target: SessionInfo) {
  await api.client.session.abort({ sessionID: target.id }).catch(() => null)
  api.ui.toast({ variant: "success", message: `Aborted: ${target.title}` })
}

async function doAbortAndMessage(api: TuiPluginApi, target: SessionInfo) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Message after abort",
      placeholder: "e.g. You were stuck. Summarize what you found and return.",
      onConfirm: async (text) => {
        api.ui.dialog.clear()
        await api.client.session.abort({ sessionID: target.id }).catch(() => null)
        const idle = await waitForIdle(api, target.id)
        if (!idle) {
          api.ui.toast({ variant: "warning", message: "Session didn't go idle after abort \u2014 message may not deliver" })
        }
        await api.client.session
          .prompt({
            sessionID: target.id,
            parts: [{ type: "text", text }],
          })
          .catch(() => null)
        api.ui.toast({ variant: "success", message: `Poked: ${target.title}` })
      },
      onCancel() {
        api.ui.dialog.clear()
      },
    }),
  )
}

async function doAbortAndPokeParent(api: TuiPluginApi, parentSessionID: string, target: SessionInfo) {
  await api.client.session.abort({ sessionID: target.id }).catch(() => null)
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
          text: `The subagent "${target.title}" (${target.id}) was stuck and has been manually aborted. Please retry the task it was working on.`,
        },
      ],
    })
    .catch(() => null)
  api.ui.toast({ variant: "success", message: "Aborted subagent and poked parent" })
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
          poke(api)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("poke.global", [POKE_CMD]),
  })
}
