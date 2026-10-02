import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitPullRequest, GitBranch, GitMerge, Wrench, RefreshCw, ChevronDown, ChevronRight, MoreHorizontal, Send, MessageSquare, ArrowUpRight, CircleCheck, CircleX, CircleHelp, Clock, CircleMinus, ShieldAlert, Sparkles } from "lucide-react";
import { ChecksChip, ReviewChip, PR_STATE } from "./PrCard";
import { Spinner } from "@/components/ui/Spinner";
import { Tip } from "@/components/ui/Tooltip";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem } from "@/components/ui/Dropdown";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePr } from "@/store/pr";
import { useDelivery } from "@/store/delivery";
import { agentTargets, pickAgentTarget } from "@/lib/sendComments";
import { forgeName, prRef } from "@/lib/forge";
import { deliveryPrompt, repositoryLookup } from "@/lib/delivery";
import { sendDeliveryMessage } from "@/lib/deliverySend";
import * as ipc from "@/lib/ipc";
import { Input } from "@/components/ui/Input";
import type { Task, DeliveryRepo, DeliveryPrInput, DeliveryRequest, DeliveryDraft, QueueItem, UpdateMode, CiNode } from "@/lib/types";

const textProps = { spellCheck: false, autoCorrect: "off", autoCapitalize: "off", autoComplete: "off" };
// Same border/focus tokens as ui/Input, sized down a step for panel density.
const field = "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[12.5px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-accent)]";
const fieldLabel = "flex flex-col gap-1.5 text-[11.5px] font-medium text-[var(--color-fg-dim)]";
const alertCls = "break-words text-[11.5px] text-[var(--color-err)]";
const action = "inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-40";
const noRepos: DeliveryRepo[] = [];
const KIND: Record<string, { icon: typeof MessageSquare; color: string }> = {
  fix: { icon: Wrench, color: "var(--color-palette-orange)" },
  replies: { icon: MessageSquare, color: "var(--color-palette-blue)" },
  prs: { icon: GitPullRequest, color: "var(--color-palette-purple)" },
  conflicts: { icon: GitMerge, color: "var(--color-warn)" },
};
const STATUS_COLOR: Record<string, string> = {
  prepared: "var(--color-fg-faint)", queued: "var(--color-accent)", sent: "var(--color-accent)",
  drafted: "var(--color-ok)", posted: "var(--color-ok)",
  uncertain: "var(--color-warn)", retry_ready: "var(--color-warn)", failed: "var(--color-err)",
  draft: "var(--color-fg-faint)", posting: "var(--color-accent)",
};
type Preview = { request: DeliveryRequest; text: string; target: string };

export function DeliveryPanel({ task }: { task: Task }) {
  const { t } = useTranslation("panels");
  const entry = useDelivery(s => s.byTask[task.id]);
  const pr = usePr(s => s.byTask[task.id]);
  // Re-render when the fields agentTargets() reads change — extend the string
  // if that selector starts using more of the tab.
  useApp(s => (s.tabs[task.id] ?? []).map(tab => tab.type === "terminal" ? [tab.id, tab.ptyId, tab.title, tab.cli, tab.runTab].join(":") : "").join("|"));
  useApp(s => s.agents);
  const repos = entry?.repos ?? noRepos;
  const [selected, setSelected] = useState<string[]>([]);
  const [items, setItems] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [prInputs, setPrInputs] = useState<DeliveryPrInput[] | null>(null);
  const [update, setUpdate] = useState<UpdateMode | null>(null);
  const targets = agentTargets(task.id);
  const chosen = repos.filter(r => selected.includes(r.dir_name) && r.identity);
  // Durable 'queued' requests need a live queue item to ever send; queue
  // entries die with the app, so a restart leaves zombies. Two consecutive
  // refreshes without the item marks it failed (send() writes the status a
  // beat before the queue item, so one sighting is not proof).
  const orphanQueued = useRef<Set<string>>(new Set());
  const refresh = async () => {
    await Promise.all([useDelivery.getState().refresh(task.id), usePr.getState().refresh(task.id, true)]);
    const reqs = useDelivery.getState().byTask[task.id]?.requests ?? [];
    const live = new Set((useApp.getState().tabs[task.id] ?? [])
      .flatMap(tab => tab.type === "terminal" ? (tab.queue ?? []).map(q => q.delivery?.requestId ?? "") : []).filter(Boolean));
    let stale = false;
    for (const r of reqs) {
      if (r.status !== "queued" || live.has(r.id)) { orphanQueued.current.delete(r.id); continue; }
      if (!orphanQueued.current.has(r.id)) { orphanQueued.current.add(r.id); continue; }
      orphanQueued.current.delete(r.id);
      stale = true;
      await ipc.taskDeliveryRequestStatus(task.id, r.id, "failed", "Queue was cleared").catch(() => {});
    }
    if (stale) await useDelivery.getState().refresh(task.id);
  };
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
    // Only the mounted Delivery panel polls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);
  const same = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  useEffect(() => {
    setSelected(prev => { const next = prev.filter(dir => repos.some(r => r.dir_name === dir)); return same(prev, next) ? prev : next; });
  }, [repos]);
  // Details are pruned on refresh when an identity changes; the evidence
  // selection, log excerpts, and expansion that reference them must go too
  // or they'd act on data the store already discarded.
  useEffect(() => {
    const live = Object.keys(entry?.details ?? {});
    // Keys are `${dir}:${kind}:${id}`; dir names may contain ':', so match by
    // prefix rather than slicing to the first colon.
    const alive = (k: string) => live.some(dir => k.startsWith(dir + ":"));
    setItems(prev => { const next = prev.filter(alive); return same(prev, next) ? prev : next; });
    setLogs(prev => {
      const next = Object.fromEntries(Object.entries(prev).filter(([k]) => alive(k)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setExpanded(prev => { const next = prev.filter(dir => live.includes(dir)); return same(prev, next) ? prev : next; });
  }, [entry?.details]);

  const toggle = (values: string[], key: string) => values.includes(key) ? values.filter(v => v !== key) : [...values, key];
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) {
      const msg = String(e);
      setError(msg);
      // The error paragraph lives at the top of a scrollable panel — actions
      // triggered deep in the details (per-thread fix/reply, CI rows) fail
      // invisibly without a toast. Dialogs render the same error inline, so
      // skip the toast while one is open.
      if (!preview && !prInputs && !update) useUI.getState().pushToast(msg, "error");
    } finally { setBusy(false); }
  };
  const applied = useRef<Record<string, { title: string; body: string }>>({});
  const showPrs = () => {
    if (!chosen.length) return;
    applied.current = {};
    setPrInputs(chosen.map(r => {
      const proposed = entry?.requests.flatMap(q => q.prs).findLast(p => p.dir_name === r.dir_name);
      const title = proposed?.title ?? task.name, body = proposed?.body ?? "";
      applied.current[r.dir_name] = { title, body };
      return { identity: r.identity!, title, body, base: r.base, draft: true };
    }));
  };
  // A draft report that lands while the dialog is open fills only fields the
  // user has not touched since the last applied draft.
  useEffect(() => {
    if (!prInputs) return;
    const latest = new Map<string, { title: string; body: string }>();
    for (const req of entry?.requests ?? []) for (const p of req.prs) latest.set(p.dir_name, { title: p.title, body: p.body });
    setPrInputs(list => {
      if (!list) return list;
      let dirty = false;
      const next = list.map(inp => {
        const p = latest.get(inp.identity.dir_name);
        const ap = applied.current[inp.identity.dir_name];
        if (!p || !ap) return inp;
        // Fill only fields still equal to the last applied draft — a field the
        // user typed into keeps its value even when a newer report arrives.
        const patch: Partial<DeliveryPrInput> = {};
        if (inp.title === ap.title && inp.title !== p.title) patch.title = p.title;
        if (inp.body === ap.body && inp.body !== p.body) patch.body = p.body;
        if (patch.title === undefined && patch.body === undefined) return inp;
        dirty = true;
        applied.current[inp.identity.dir_name] = { title: patch.title ?? ap.title, body: patch.body ?? ap.body };
        return { ...inp, ...patch };
      });
      return dirty ? next : list;
    });
  }, [entry?.requests]); // eslint-disable-line react-hooks/exhaustive-deps
  const prepare = async (purpose: "fix" | "replies" | "prs" | "conflicts", scope = chosen, keys = items) => {
    const drafts: DeliveryDraft[] = [];
    const evidence: string[] = [];
    const scopeBits: string[] = [];
    let picked = 0;
    const scoped = scope.filter(repo => repo.identity && (purpose === "prs" || purpose === "conflicts" || keys.some(k => k.startsWith(repo.dir_name + ":")))).map(repo => {
      const detail = entry?.details[repo.dir_name];
      if (purpose === "prs" || purpose === "conflicts") scopeBits.push(repo.name);
      if (purpose === "prs") return repo;
      if (purpose === "conflicts") {
        const outcome = entry?.results.find(r => r.dir_name === repo.dir_name);
        if (!outcome?.result?.conflicted && !outcome?.result?.stash_conflicted) throw new Error(t("delivery.noConflict"));
        evidence.push(JSON.stringify(outcome));
        return repo;
      }
      if (!detail) throw new Error(t("delivery.loadFirst"));
      if (detail.ci_error && keys.some(k => k.startsWith(repo.dir_name + ":ci:"))) throw new Error(detail.ci_error);
      if (detail.threads_error && keys.some(k => k.startsWith(repo.dir_name + ":review:"))) throw new Error(detail.threads_error);
      // Fixable evidence is a failed CI node or an unresolved thread; replies
      // may target any thread and keep selected CI as prompt context.
      const threads = detail.threads.filter(thread => keys.includes(repo.dir_name + ":review:" + thread.id) && (purpose !== "fix" || thread.resolved !== true));
      const ci = detail.ci.filter(node => keys.includes(repo.dir_name + ":ci:" + node.id) && (purpose !== "fix" || node.status === "failed"));
      picked += threads.length + ci.length;
      const names = [...ci.map(n => n.name), ...threads.map(th => th.path ? `${th.path}${th.line ? ":" + th.line : ""}` : t("delivery.discussion"))];
      if (names.length) scopeBits.push(`${repo.name}: ${names.join(", ")}`);
      evidence.push(JSON.stringify({ repository: repo.name, provider: detail.pr.provider, pr: detail.pr.url, revision: detail.revision, threads, ci,
        logs: ci.map(n => ({ id: n.id, excerpt: logs[repo.dir_name + ":ci:" + n.id] ?? null })) }));
      if (purpose === "replies") for (const thread of threads) drafts.push({ key: repo.dir_name + ":review:" + thread.id, dir_name: repo.dir_name, pr_number: detail.pr.number,
        thread_id: thread.id, reply_id: thread.reply_id, body: "", status: "draft", error: null });
      return { ...repo, identity: { ...repo.identity!, pr_number: detail.pr.number, pr_revision: detail.revision } };
    });
    if ((purpose === "fix" && !picked) || (purpose === "replies" && !drafts.length)) throw new Error(t("delivery.selectEvidence"));
    const request = await ipc.taskDeliveryRequest(task.id, scoped.map(r => r.identity!), drafts, purpose, scopeBits.join(" · "));
    const text = deliveryPrompt(scoped, evidence.join("\n\n") + "\nRequested draft keys: " + drafts.map(d => d.key).join(", "),
      request.report, t(`delivery.purpose.${purpose}`));
    setPreview({ request, text, target: pickAgentTarget(task.id)?.id ?? "" });
    await useDelivery.getState().refresh(task.id);
  };
  const send = async (queue: boolean) => {
    if (!preview) return;
    const target = agentTargets(task.id).find(tab => tab.id === preview.target);
    if (!target?.ptyId) throw new Error(t("delivery.agentChanged"));
    const item: QueueItem = { id: crypto.randomUUID(), text: preview.text, repeat: 1, remaining: 1,
      delivery: { requestId: preview.request.id, identities: preview.request.identities, ptyId: target.ptyId } };
    await ipc.taskDeliveryValidate(task.id, preview.request.identities);
    if (queue) {
      const current = agentTargets(task.id).find(tab => tab.id === target.id && tab.ptyId === target.ptyId);
      if (!current) throw new Error(t("delivery.agentChanged"));
      await ipc.taskDeliveryRequestStatus(task.id, preview.request.id, "queued");
      // A double-queue of the same request is one entry: the drain would
      // otherwise deliver it, see "sent", and still burn a send pass.
      const rest = (current.queue ?? []).filter(q => q.delivery?.requestId !== item.delivery!.requestId);
      useApp.getState().patchTab(task.id, target.id, { queue: [...rest, item], queueActive: true, queueKick: (current.queueKick ?? 0) + 1 });
      useUI.getState().pushToast(t("delivery.queued"));
    } else if (!await sendDeliveryMessage(task.id, target.id, item)) {
      await useDelivery.getState().refresh(task.id);
      return;
    }
    setPreview(null);
    await useDelivery.getState().refresh(task.id);
  };
  // Closing without sending retires the 'prepared' request — otherwise every
  // abandoned handoff leaks a durable row in delivery.json forever. Re-read
  // the status first: a request already sent/queued elsewhere must be left
  // alone.
  const cancelPreview = () => {
    const p = preview;
    setPreview(null);
    if (p) void ipc.taskDeliveryRequests(task.id).then(list => {
      const cur = list.find(r => r.id === p.request.id);
      if (cur?.status === "prepared") return ipc.taskDeliveryRequestStatus(task.id, cur.id, "failed");
    }).then(() => useDelivery.getState().refresh(task.id)).catch(() => {});
  };
  const changePr = (i: number, patch: Partial<DeliveryPrInput>) => setPrInputs(list => list!.map((p, n) => n === i ? { ...p, ...patch } : p));
  const failed = repos.filter(repo => entry?.results.some(r => r.dir_name === repo.dir_name && (r.result?.conflicted || r.result?.stash_conflicted)));
  // Split a `${dir}:${kind}:${id}` evidence key: match the repo prefix so dir
  // names containing ':' keep working.
  const parseKey = (k: string) => {
    const repo = repos.find(r => k.startsWith(r.dir_name + ":"));
    return repo ? { repo, rest: k.slice(repo.dir_name.length + 1) } : null;
  };
  // "Send to agent" only makes sense when the selection holds something an
  // agent can act on: a failed CI node or an unresolved review thread.
  const canFix = items.some(k => {
    const p = parseKey(k);
    if (!p) return false;
    const detail = entry?.details[p.repo.dir_name];
    if (p.rest.startsWith("ci:")) return detail?.ci.some(n => n.id === p.rest.slice(3) && n.status === "failed");
    if (p.rest.startsWith("review:")) return detail?.threads.some(th => th.id === p.rest.slice(7) && th.resolved !== true);
    return false;
  });
  const canReply = items.some(k => parseKey(k)?.rest.startsWith("review:"));
  // 'prepared' lives in the send dialog; dismissed ('failed' with no error)
  // is hidden. Queued, in-flight, drafted, and wedged requests stay visible
  // so a send never silently disappears.
  const shown = entry?.requests.filter(r => r.status !== "prepared" && (r.status !== "failed" || r.error)) ?? [];
  return <section data-testid="delivery-panel" className="relative flex min-h-0 flex-1 flex-col overflow-auto text-xs">
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 py-2">
      <span className="min-w-0 flex-1 text-[12px] font-medium">{t("delivery.panelTitle")}</span>
      <Tip content={t("delivery.refresh")}><button aria-label={t("delivery.refresh")} className={action} disabled={busy || entry?.loading} onClick={() => void run(refresh)}>{busy || entry?.loading ? <Spinner size={13} /> : <RefreshCw className="h-3.5 w-3.5" />}</button></Tip>
      <DropdownRoot><DropdownTrigger asChild><button data-testid="delivery-actions" className={action} disabled={busy || !chosen.length}>{t("delivery.repoActions")}<ChevronDown className="h-3 w-3" /></button></DropdownTrigger>
        <DropdownMenu>
          <DropdownItem onSelect={showPrs}><GitPullRequest className="h-4 w-4" />{t("delivery.createPrs")}</DropdownItem>
          <DropdownItem onSelect={() => setUpdate("merge")}><GitBranch className="h-4 w-4" />{t("delivery.update")}</DropdownItem>
        </DropdownMenu>
      </DropdownRoot>
    </div>
    <div className="space-y-3 p-3">
    <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-faint)]">
      <label className="flex flex-1 items-center gap-2"><input type="checkbox" aria-label={t("delivery.selectAll")} checked={repos.some(r => r.identity) && selected.length === repos.filter(r => r.identity).length} onChange={() => setSelected(selected.length === repos.filter(r => r.identity).length ? [] : repos.filter(r => r.identity).map(r => r.dir_name))} />{chosen.length ? t("delivery.selectedRepos", { count: chosen.length }) : t("delivery.selectRepos")}</label>
    </div>
    {(error || entry?.error || pr?.error) && <p role="alert" className="text-[var(--color-err)]">{error || entry?.error || pr?.error}{(entry?.fetchedAt ?? 0) > 0 ? " " + t("delivery.stale") : ""}</p>}
    {entry?.loading && !entry.fetchedAt && <p>{t("shared.loading")}</p>}
    {repos.map(repo => {
      const detail = entry?.details[repo.dir_name];
      const sharedHost = !!task.is_main_checkout && !repo.dir_name;
      const lookup = sharedHost && detail ? { status: "ok", message: "", pr: detail.pr } : repositoryLookup(pr, repo.dir_name);
      const state = lookup?.pr ? PR_STATE[lookup.pr.state] : null;
      return <article key={repo.dir_name} data-testid="delivery-repo" className="overflow-hidden rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] transition-colors" style={selected.includes(repo.dir_name) ? { borderColor: `color-mix(in srgb, var(--color-accent) 50%, transparent)` } : undefined}>
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <input aria-label={repo.name} type="checkbox" disabled={!repo.identity || busy} checked={selected.includes(repo.dir_name)} onChange={() => setSelected(toggle(selected, repo.dir_name))} />
            <strong className="min-w-0 flex-1 truncate text-[12px]">{repo.name}</strong>
            {repo.mode === "repo_root" && <span className="rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-faint)]">{t("delivery.sharedCheckout")}</span>}
            {lookup?.pr && <button className={action + " -mr-2"} aria-label={t("delivery.openProvider")} onClick={() => void ipc.openPath(lookup.pr!.url)}><ArrowUpRight className="h-3.5 w-3.5" /></button>}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-faint)]" title={repo.identity?.path}>
            <GitBranch className="h-3 w-3 shrink-0" /><span className="min-w-0 truncate font-mono">{repo.identity?.branch || t("delivery.unknown")}</span>
            <span className="ml-auto shrink-0" style={{ color: repo.dirty ? "var(--color-warn)" : undefined }}>{repo.dirty ? t("delivery.uncommitted") : repo.changed ? t("delivery.branchChanges") : repo.changed === false ? t("delivery.clean") : t("delivery.unknown")}</span>
          </div>
          {lookup?.pr && state ? <>
            <div className="flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1 text-[11px]" style={{ color: state.color }}><state.Icon className="h-3.5 w-3.5" />{t(state.labelKey)}</span><ChecksChip checks={lookup.pr.checks} /><ReviewChip review={lookup.pr.review} /></div>
            <p className="text-[12px] leading-5"><span className="mr-1.5 text-[var(--color-fg-faint)]">{forgeName(lookup.pr.provider)} {prRef(lookup.pr.provider, lookup.pr.number)}</span>{lookup.pr.title}</p>
          </> : <p className="text-[11.5px] text-[var(--color-fg-dim)]">{lookup?.message || t("delivery.noPr")}</p>}
          {repo.error && <p role="alert" className="text-[var(--color-err)]">{repo.error}</p>}
        </div>
        <button data-testid="delivery-repo-details" className="flex w-full items-center gap-1.5 border-t border-[var(--color-border-soft)] px-3 py-2 text-left text-[11px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] disabled:opacity-40" disabled={busy || !repo.identity || (!detail && !lookup?.pr && !sharedHost)} onClick={() => void run(async () => {
          if (expanded.includes(repo.dir_name)) { setExpanded(toggle(expanded, repo.dir_name)); return; }
          if (!detail) await useDelivery.getState().details(task.id, repo.identity!);
          setExpanded(toggle(expanded, repo.dir_name));
        })}>
          {expanded.includes(repo.dir_name) ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {t("delivery.viewDetails")}
          {detail && <span className="ml-auto text-[var(--color-palette-teal)]">{t("delivery.detailCounts", { ci: detail.ci.filter(n => n.kind === "job" || n.kind === "check").length, threads: detail.threads.filter(t => t.resolved !== true).length })}</span>}
        </button>
        {detail && expanded.includes(repo.dir_name) && <div className="space-y-3 border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-3">
          <div className="flex items-center gap-2 text-[10px] text-[var(--color-fg-faint)]"><span title={detail.revision}>{t("delivery.revision")}: <code>{detail.revision.slice(0, 8)}</code></span><button className="ml-auto hover:text-[var(--color-fg)]" aria-label={t("delivery.refresh")} onClick={() => void run(async () => { await useDelivery.getState().details(task.id, repo.identity!); setItems([]); setLogs({}); })}><RefreshCw className="h-3 w-3" /></button></div>
          <details open className="group"><summary className="cursor-pointer text-[11px] font-medium">{t("delivery.ciStatus")}</summary>
            {detail.ci_error && <p role="alert" className={alertCls}>{detail.ci_error}</p>}
            {!detail.ci.length && !detail.ci_error && <p className="text-[var(--color-fg-faint)]">{t("delivery.noCi")}</p>}
            <CiTree nodes={detail.ci} parent={null} seen={[]} render={node => {
              const key = repo.dir_name + ":ci:" + node.id;
              const failed = node.status === "failed";
              return <div className="w-full space-y-1"><div className="flex items-center gap-1"><label className="flex min-w-0 flex-1 items-center gap-1.5 py-1">{failed ? <input type="checkbox" checked={items.includes(key)} onChange={() => { setItems(toggle(items, key)); if (!selected.includes(repo.dir_name)) setSelected([...selected, repo.dir_name]); }} /> : <span className="w-3 shrink-0" />}<CiState status={node.status} /><span className="min-w-0 flex-1 break-words">{node.name}</span><span className="shrink-0 text-[10px] text-[var(--color-fg-faint)]">{t(`delivery.ciStates.${node.status}`, { defaultValue: node.status })}{node.duration != null ? " · " + Math.round(node.duration) + "s" : ""}</span></label>
                {failed && <button className={action + " p-1"} disabled={busy} title={t("delivery.fixCi")} aria-label={t("delivery.fixCi")} onClick={() => void run(() => prepare("fix", [repo], [key]))}><Wrench className="h-3 w-3" /></button>}
                {node.url && <button className={action + " p-1"} aria-label={t("delivery.openProvider")} onClick={() => void ipc.openPath(node.url)}><ArrowUpRight className="h-3 w-3" /></button>}</div>
                {node.log_id && failed && <button className={action + " ml-5 py-0.5"} disabled={busy} onClick={() => void run(async () => {
                  const expected = { ...detail.identity, pr_number: detail.pr.number, pr_revision: detail.revision };
                  const excerpt = await ipc.taskDeliveryLog(task.id, expected, node.log_id!);
                  setLogs(s => ({ ...s, [key]: excerpt }));
                })}>{t("delivery.loadLog")}</button>}
                {logs[key] && <pre className="max-h-48 overflow-auto rounded bg-[var(--color-bg-2)] p-2 font-mono text-[10.5px] leading-4 whitespace-pre-wrap break-all">{logs[key]}</pre>}
              </div>;
            }} />
          </details>
          <details open><summary className="cursor-pointer text-[11px] font-medium">{t("delivery.reviewStatus")}</summary>
            {detail.threads_error && <p role="alert" className={alertCls}>{detail.threads_error}</p>}
            {!detail.threads.length && !detail.threads_error && <p className="text-[var(--color-fg-faint)]">{t("delivery.noThreads")}</p>}
            {detail.threads.map(thread => {
              const key = repo.dir_name + ":review:" + thread.id;
              return <div key={key} className={`my-2 space-y-2 rounded-md border border-[var(--color-border-soft)] p-2 ${thread.resolved === true ? "opacity-60" : ""}`}>
                <label className="flex items-start gap-1.5 text-[11px]"><input className="mt-0.5 shrink-0" type="checkbox" checked={items.includes(key)} onChange={() => { setItems(toggle(items, key)); if (!selected.includes(repo.dir_name)) setSelected([...selected, repo.dir_name]); }} /> {thread.path ?? t("delivery.discussion")}{thread.line ? ":" + thread.line : ""} · {thread.resolved === true ? t("delivery.resolved") : thread.resolved === false ? t("delivery.unresolved") : t("delivery.discussion")}</label>
                <div className="max-h-56 space-y-3 overflow-auto">{thread.comments.map(c => <div key={c.id}><p className="mb-1 text-[10.5px] font-medium text-[var(--color-fg-faint)]">{c.author}</p><p className="whitespace-pre-wrap break-words text-[11.5px] leading-5">{c.body}</p></div>)}</div>
                <div className="flex items-center gap-1">
                  <button className={action + " -ml-2 py-0.5"} onClick={() => void ipc.openPath(thread.url || detail.pr.url)}><ArrowUpRight className="h-3 w-3" />{t("delivery.openProvider")}</button>
                  <span className="ml-auto flex items-center gap-1">
                    <button className={action + " py-0.5"} disabled={busy || !repo.identity} onClick={() => void run(() => prepare("replies", [repo], [key]))}><MessageSquare className="h-3 w-3" />{t("delivery.replyThread")}</button>
                    {thread.resolved !== true && <button className={action + " py-0.5"} disabled={busy || !repo.identity} onClick={() => void run(() => prepare("fix", [repo], [key]))}><Wrench className="h-3 w-3" />{t("delivery.fixThread")}</button>}
                  </span>
                </div>
              </div>;
            })}
          </details>
        </div>}
      </article>;
    })}
    {!!entry?.results.length && <div data-testid="delivery-results" className="space-y-2">
      <div className="flex items-center gap-2"><strong className="flex-1">{t("delivery.results")}</strong>{failed.length > 0 && <button className={action} disabled={busy} onClick={() => void run(() => prepare("conflicts", failed))}><Send className="h-3 w-3" />{t("delivery.actions.conflicts")}</button>}</div>
      {entry.results.map(result => {
        const Icon = result.error ? CircleX : result.result?.conflicted || result.result?.stash_conflicted ? ShieldAlert : CircleCheck;
        const color = result.error ? "var(--color-err)" : result.result?.conflicted || result.result?.stash_conflicted ? "var(--color-warn)" : "var(--color-ok)";
        return <p key={result.dir_name} role={result.error ? "alert" : undefined} className="flex items-start gap-1.5">
          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color }} />
          <span className={`min-w-0 flex-1 break-words ${result.error ? "text-[var(--color-err)]" : ""}`}><strong className="font-medium">{result.name}</strong> · {result.error || (result.result?.conflicted ? t("delivery.conflict") : result.result?.stash_conflicted ? t("delivery.stashConflict") : t("delivery.success"))}
            {result.result?.stashed && " · " + t("delivery.autostash")}
            {result.result?.target && " · " + result.result.target}
            {result.url && <button className="ml-1.5 underline" onClick={() => void ipc.openPath(result.url!)}>{t("delivery.openProvider")}</button>}
          </span>
        </p>;
      })}
      {entry.results.some(r => r.error || r.result?.conflicted || r.result?.stash_conflicted) && <button className={action} onClick={() => setSelected(entry.results.filter(r => r.error || r.result?.conflicted || r.result?.stash_conflicted).map(r => r.dir_name))}>{t("delivery.selectFailed")}</button>}
    </div>}
    {entry && !entry.loading && !shown.length && !entry.results.length && <p className="rounded-md border border-dashed border-[var(--color-border-soft)] px-3 py-2.5 text-[11px] leading-5 text-[var(--color-fg-faint)]">{t("delivery.hint")}</p>}
    {!!shown.length && <div data-testid="delivery-requests" className="space-y-2">
      <strong>{t("delivery.requests")}</strong>
      {shown.map(request => {
        const kind = KIND[request.kind] ?? KIND.replies;
        const KindIcon = kind.icon;
        const waiting = request.status === "sent" && !request.error &&
          (request.kind === "prs" ? !request.prs.length : request.drafts.some(d => !d.body));
        const dismissable = request.status !== "drafted" &&
          (["queued", "sent", "uncertain", "failed"].includes(request.status) || !!request.error);
        // Requests saved before `scope` existed fall back to repo names.
        const scopeLabel = request.scope || request.identities.map(i => repos.find(r => r.dir_name === i.dir_name)?.name ?? i.dir_name).join(", ");
        return <div key={request.id} data-testid="delivery-request" className="space-y-2 rounded-lg border border-[var(--color-border-soft)] border-l-2 bg-[var(--color-bg-2)] p-2.5" style={{ borderLeftColor: `color-mix(in srgb, ${kind.color} 60%, transparent)` }}>
          <div className="flex items-center gap-1.5">
            <KindIcon className="h-3.5 w-3.5 shrink-0 self-start mt-px" style={{ color: kind.color }} />
            <div className="min-w-0 flex-1">
              <span className="text-[11.5px] font-medium">{t(`delivery.actions.${request.kind}`, { defaultValue: request.kind })}</span>
              {scopeLabel && <p className="truncate text-[10.5px] text-[var(--color-fg-faint)]" title={scopeLabel}>{scopeLabel}</p>}
            </div>
            <StatusChip status={request.status} kind="requestStates" />
            {dismissable && <button className={action + " -mr-1.5 px-1.5 py-0.5"} disabled={busy} onClick={() => void run(async () => {
              await ipc.taskDeliveryRequestStatus(task.id, request.id, "failed");
              // Dismiss also kills undelivered queue copies — 'failed' still
              // passes the send gate so a queued item would type anyway.
              const app = useApp.getState();
              for (const tab of app.tabs[task.id] ?? [])
                if (tab.type === "terminal" && tab.queue?.some(q => q.delivery?.requestId === request.id))
                  app.patchTab(task.id, tab.id, { queue: tab.queue!.filter(q => q.delivery?.requestId !== request.id) });
              await useDelivery.getState().refresh(task.id);
            })}>{t("delivery.dismiss")}</button>}
          </div>
          {request.error && <p role="alert" className={alertCls}>{request.error}</p>}
          {waiting && <p className="text-[11px] text-[var(--color-fg-faint)]">{t("delivery.waitingReport")}</p>}
          {request.prs.map(p => {
            const repo = repos.find(r => r.dir_name === p.dir_name);
            return <div key={p.dir_name} className="space-y-1 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-2">
              <div className="flex items-center gap-1.5">
                <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-[var(--color-palette-purple)]" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium" title={p.title}>{repo?.name ?? p.dir_name} · {p.title}</span>
                {repo?.identity && <button className={action + " -mr-1 px-1.5 py-0.5"} disabled={busy} onClick={() => { applied.current[p.dir_name] = { title: p.title, body: p.body }; setPrInputs([{ identity: repo.identity!, title: p.title, body: p.body, base: repo.base, draft: true }]); }}>{t("delivery.createPr")}</button>}
              </div>
              {p.body && <details><summary className="cursor-pointer text-[10.5px] text-[var(--color-fg-faint)]">{t("delivery.body")}</summary><p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-5">{p.body}</p></details>}
            </div>;
          })}
          {request.drafts.filter(d => request.status === "drafted" || d.body || d.error).map(draft => <ReplyDraft key={draft.key} taskId={task.id} request={request} draft={draft} repo={repos.find(r => r.dir_name === draft.dir_name)} />)}
        </div>;
      })}
    </div>}
    </div>
    {items.length > 0 && <div className="sticky bottom-0 z-10 mt-auto flex items-center gap-2 border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 py-2">
      <span className="flex-1 text-[11px] text-[var(--color-fg-dim)]">{t("delivery.selectedItems", { count: items.length })}</span>
      <DropdownRoot><DropdownTrigger asChild><button className={action} aria-label={t("delivery.moreActions")}><MoreHorizontal className="h-4 w-4" /></button></DropdownTrigger>
        <DropdownMenu><DropdownItem disabled={busy || !canReply} onSelect={() => void run(() => prepare("replies"))}>{t("delivery.actions.replies")}</DropdownItem><DropdownItem onSelect={() => setItems([])}>{t("delivery.clearSelection")}</DropdownItem></DropdownMenu>
      </DropdownRoot>
      {canFix && <button className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--color-accent)] px-2.5 py-1.5 text-[11px] font-medium text-white disabled:opacity-40" disabled={busy} onClick={() => void run(() => prepare("fix"))}><Wrench className="h-3 w-3" />{t("delivery.fixSelected")}</button>}
    </div>}
    <AppDialog open={!!preview} onOpenChange={open => { if (!open && !busy) cancelPreview(); }} className="max-w-2xl" title={t("delivery.reviewSend")} description={t("delivery.scopeNotice")}
      stickyFooter={preview && <>
        {error && <p role="alert" className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap text-[12.5px] text-[var(--color-err)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={cancelPreview}>{t("common:cancel")}</Button>
          <Button variant="secondary" size="sm" disabled={busy || !preview.target || !preview.text.trim()} onClick={() => void run(() => send(true))}>{t("delivery.queue")}</Button>
          <Button variant="primary" size="sm" data-testid="delivery-send" disabled={busy || !preview.target || !preview.text.trim()} onClick={() => void run(() => send(false))}>{t("delivery.send")}</Button>
        </div>
      </>}>
      {preview && <div className="space-y-3">
        <label className={fieldLabel}>{t("delivery.agent")}<select className={field} value={preview.target} onChange={e => setPreview({ ...preview, target: e.target.value })}><option value="">{t("delivery.selectAgent")}</option>{targets.map(tab => <option key={tab.id} value={tab.id}>{tab.title || tab.cli} · {tab.id.slice(0, 8)}</option>)}</select></label>
        {!targets.length && <p className="text-[11.5px] text-[var(--color-warn)]">{t("reviewBar.noAgent")}</p>}
        <div className="space-y-1 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-faint)]">{t("delivery.scope")}</p>
          {preview.request.identities.map(i => {
            const repo = repos.find(r => r.dir_name === i.dir_name);
            return <p className="flex items-baseline gap-1.5 text-[11.5px]" key={i.dir_name} title={i.path}>
              <span className="shrink-0 font-medium">{repo?.name ?? i.dir_name}</span>
              <span className="min-w-0 break-all font-mono text-[10.5px] text-[var(--color-fg-faint)]">{i.branch} · {i.head.slice(0, 8)}{i.pr_number != null && " · " + prRef(repositoryLookup(pr, i.dir_name)?.provider, i.pr_number) + " · " + i.pr_revision?.slice(0, 8)}</span>
            </p>;
          })}
        </div>
        <label className={fieldLabel}>{t("delivery.prompt")}<textarea {...textProps} className={field + " min-h-72 resize-y font-mono text-[11.5px] leading-5"} value={preview.text} onChange={e => setPreview({ ...preview, text: e.target.value })} /></label>
      </div>}
    </AppDialog>
    <AppDialog open={!!prInputs} onOpenChange={open => { if (!open && !busy) setPrInputs(null); }} className="max-w-2xl" title={t("delivery.createPrs")} description={t("delivery.prNotice")}
      stickyFooter={prInputs && <>
        {error && <p role="alert" className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap text-[12.5px] text-[var(--color-err)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy || !agentTargets(task.id).length} onClick={() => void run(() => prepare("prs", repos.filter(r => prInputs?.some(p => p.identity.dir_name === r.dir_name))))}>{t("delivery.draftAll")}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPrInputs(null)}>{t("common:cancel")}</Button>
          <Button variant="primary" size="sm" disabled={busy || !prInputs.length} onClick={() => void run(async () => {
            useDelivery.getState().results(task.id, await ipc.taskDeliveryPrCreate(task.id, prInputs)); setPrInputs(null); await refresh();
          })}>{t("delivery.createSelected")}</Button>
        </div>
      </>}>
      {prInputs?.map((input, i) => {
        const existing = repositoryLookup(pr, input.identity.dir_name)?.pr;
        const reused = existing && (existing.state === "open" || existing.state === "draft") ? existing : null;
        return <fieldset key={input.identity.dir_name} className="min-w-0 space-y-2.5 rounded-md border border-[var(--color-border-soft)] px-3 pb-3 pt-1"><legend className="flex items-center gap-2 px-1 text-[11.5px] font-medium"><span>{repos.find(r => r.dir_name === input.identity.dir_name)?.name}</span><button type="button" className={action + " -my-0.5 py-0.5"} disabled={busy || !agentTargets(task.id).length} title={t("delivery.draftWithAgent")} onClick={() => void run(() => prepare("prs", [repos.find(r => r.dir_name === input.identity.dir_name)!]))}><Sparkles className="h-3 w-3" />{t("delivery.draftWithAgent")}</button></legend><p className="truncate font-mono text-[10.5px] text-[var(--color-fg-faint)]" title={input.identity.path}>{input.identity.branch} · {input.identity.remote}</p>
        {reused && <p className="text-[11.5px] text-[var(--color-warn)]">{t("delivery.reusePr", { ref: prRef(reused.provider, reused.number) })}</p>}
        <label className={fieldLabel}>{t("delivery.title")}<Input value={input.title} onChange={e => changePr(i, { title: e.target.value })} /></label>
        <div className="flex items-end gap-3">
          <label className={fieldLabel + " min-w-0 flex-1"}>{t("delivery.base")}<Input value={input.base} onChange={e => changePr(i, { base: e.target.value })} /></label>
          <label className="flex shrink-0 items-center gap-1.5 pb-2 text-[12px] text-[var(--color-fg-dim)]"><input type="checkbox" checked={input.draft} onChange={e => changePr(i, { draft: e.target.checked })} /> {t("delivery.draft")}</label>
        </div>
        <label className={fieldLabel}>{t("delivery.body")}<textarea {...textProps} rows={5} className={field + " resize-y font-mono text-[11.5px] leading-5"} value={input.body} onChange={e => changePr(i, { body: e.target.value })} /></label>
      </fieldset>;
      })}
    </AppDialog>
    <AppDialog open={!!update} onOpenChange={open => { if (!open && !busy) setUpdate(null); }} className="max-w-lg" title={t("delivery.update")} description={t("delivery.updateNotice")}
      stickyFooter={update && <>
        {error && <p role="alert" className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap text-[12.5px] text-[var(--color-err)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setUpdate(null)}>{t("common:cancel")}</Button>
          <Button variant="primary" size="sm" disabled={busy || !chosen.length} onClick={() => void run(async () => {
            useDelivery.getState().results(task.id, await ipc.taskDeliveryUpdate(task.id, chosen.map(r => r.identity!), update)); setUpdate(null); await refresh();
          })}>{t("delivery.updateSelected")}</Button>
        </div>
      </>}>
      {chosen.map(r => <p className="flex items-baseline gap-1.5 text-[11.5px]" key={r.dir_name} title={r.identity!.path}>
        <span className="shrink-0 font-medium">{r.name}</span>
        <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--color-fg-faint)]">{r.identity!.branch} → {r.base}</span>
        <span className="ml-auto shrink-0 text-[10.5px]" style={{ color: r.dirty ? "var(--color-warn)" : "var(--color-fg-faint)" }}>{r.dirty ? t("delivery.autostash") : t("delivery.clean")}</span>
      </p>)}
      <label className={fieldLabel}>{t("delivery.method")}<select className={field} value={update ?? "merge"} onChange={e => setUpdate(e.target.value as UpdateMode)}>{(["pull", "merge", "rebase"] as const).map(mode => <option value={mode} key={mode}>{t(`delivery.methods.${mode}`)}</option>)}</select></label>
    </AppDialog>
  </section>;
}

function StatusChip({ status, kind }: { status: string; kind: "requestStates" | "replyStates" }) {
  const { t } = useTranslation("panels");
  const color = STATUS_COLOR[status] ?? "var(--color-fg-faint)";
  return <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ color, background: `color-mix(in srgb, ${color} 14%, var(--color-bg-3))` }}>
    <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
    {t(`delivery.${kind}.${status}`, { defaultValue: status })}
  </span>;
}

// ponytail: bounded provider lists make this scan cheap; index children if thousands of jobs become common.
function CiTree({ nodes, parent, seen, render }: { nodes: CiNode[]; parent: string | null; seen: string[]; render: (node: CiNode) => React.ReactNode }) {
  // Not <details>/<summary>: a click anywhere in a summary toggles it, and the
  // rendered row holds buttons and a checkbox — clicking "Open provider" on a
  // pipeline node collapsed it, and ticking its checkbox did both.
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  return <ul className="mt-2 space-y-1">{nodes.filter(n => n.parent === parent && !seen.includes(n.id)).map(node => {
    const hasChildren = nodes.some(n => n.parent === node.id);
    const open = openMap[node.id] ?? ["failed", "running", "pending", "approval"].includes(node.status);
    return <li key={node.id}>{hasChildren ? <>
      <div className="flex items-start gap-1">
        <button type="button" aria-label={node.name} aria-expanded={open} className="mt-1 shrink-0 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]" onClick={() => setOpenMap(s => ({ ...s, [node.id]: !open }))}><ChevronRight className={`h-3 w-3 ${open ? "rotate-90" : ""}`} /></button>
        <div className="min-w-0 flex-1">{render(node)}</div>
      </div>
      {open && <div className="ml-1.5 border-l border-[var(--color-border-soft)] pl-3"><CiTree nodes={nodes} parent={node.id} seen={[...seen, node.id]} render={render} /></div>}
    </> : render(node)}</li>;
  })}</ul>;
}

function ReplyDraft({ taskId, request, draft, repo }: { taskId: string; request: DeliveryRequest; draft: DeliveryDraft; repo?: DeliveryRepo }) {
  const { t } = useTranslation("panels");
  const provider = repositoryLookup(usePr(s => s.byTask[taskId]), draft.dir_name)?.provider ?? null;
  const cacheKey = taskId + ":" + request.id + ":" + draft.key;
  const [body, setBody] = useState(() => useDelivery.getState().edits[cacheKey] ?? draft.body);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (useDelivery.getState().edits[cacheKey] === undefined) setBody(draft.body); }, [draft.body, cacheKey]);
  // Once a draft leaves "draft" the textarea locks — an orphaned local edit
  // would otherwise pin "Unsaved edits" forever on a posted reply.
  useEffect(() => {
    if (draft.status !== "draft") { useDelivery.getState().edit(cacheKey, undefined); setBody(draft.body); }
  }, [draft.status, draft.body, cacheKey]);
  const perform = async (post: boolean) => {
    setBusy(true); setError("");
    try {
      if (draft.status === "draft") {
        await ipc.taskDeliveryDraftSave(taskId, request.id, draft.key, body);
        useDelivery.getState().edit(cacheKey, undefined);
      }
      if (post) {
        if (!repo?.identity) throw new Error(t("delivery.loadFirst"));
        await ipc.taskDeliveryReplyPost(taskId, request.id, draft.key, repo.identity);
      }
      await useDelivery.getState().refresh(taskId);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-2 space-y-2">
    <p className="flex items-center gap-1.5 text-[11px]"><MessageSquare className="h-3 w-3 shrink-0 text-[var(--color-palette-blue)]" /><span className="min-w-0 flex-1 truncate font-medium">{repo?.name ?? draft.dir_name} · {prRef(provider, draft.pr_number)}</span><StatusChip status={draft.status} kind="replyStates" /></p>
    <textarea {...textProps} aria-label={t("delivery.reply")} placeholder={t("delivery.replyPlaceholder")} className={field} value={body} disabled={draft.status !== "draft" || busy} onChange={e => { setBody(e.target.value); useDelivery.getState().edit(cacheKey, e.target.value); }} />
    {body !== draft.body && <p className="text-[var(--color-warn)]">{t("delivery.unsaved")}</p>}
    {(error || draft.error) && <p role="alert" className={alertCls}>{error || draft.error}</p>}
    <div className="flex gap-2"><button className={action} disabled={busy || draft.status !== "draft"} onClick={() => void perform(false)}>{t("delivery.save")}</button>
      <button className={action} disabled={busy || draft.status === "posted" || !body.trim() || !repo?.identity} onClick={() => void perform(true)}>{draft.status === "uncertain" || draft.status === "posting" ? t("delivery.verifyPost") : draft.status === "retry_ready" ? t("delivery.retryReply") : t("delivery.postReply")}</button></div>
  </div>;
}

function CiState({ status }: { status: string }) {
  const Icon = status === "passed" ? CircleCheck : status === "failed" ? CircleX : status === "approval" ? ShieldAlert : status === "pending" || status === "running" ? Clock : status === "skipped" || status === "canceled" ? CircleMinus : CircleHelp;
  const color = status === "passed" ? "var(--color-ok)" : status === "failed" ? "var(--color-err)" : status === "approval" || status === "pending" || status === "running" ? "var(--color-warn)" : "var(--color-fg-faint)";
  return <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} aria-label={status} />;
}
