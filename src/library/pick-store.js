// The film picks as both pages hold them (the library page's film button, the film picker). Plain
// browser JavaScript, read as text and inlined into each page by its writer (page.ts, film-page.ts)
// in place of /*__PICKSTORE__*/null, so the two pages share one implementation without a build step;
// test/film-picker.test.ts runs the very same text. Nothing here may depend on the page around it.
//
// confirmed: the server's last answer (GET /picks on load, every POST answer), or from disk the picks
// inlined when the page was written. queue: the changes not yet answered, in order. What is shown is
// always confirmed with the queue replayed, recomputed after every answer and every failure: a failed
// change drops out, so nothing shows a state the server does not have. Served, each change is one
// request (/pick/<no>, /unpick/<no>, or /picks for several), one at a time, in order. From disk nothing
// is sent: what differs from the inlined picks is the pending list, as pnpm pick / unpick commands.
(function createPickStore(o) {
  "use strict";
  // o: { served: boolean, initial: number[], fetch?: fetch, onChange?: () => void, onError?: (text) => void }
  const doFetch = o.fetch || ((...a) => fetch(...a));
  const onChange = o.onChange || (() => {});
  const onError = o.onError || (() => {});
  const base = new Set(o.initial || []);
  let confirmed = new Set(base);
  const queue = [];
  const shown = new Set(base);
  let chain = Promise.resolve();
  let answered = false;
  const recompute = () => {
    shown.clear();
    for (const n of confirmed) shown.add(n);
    for (const op of queue) { for (const n of op.pick) shown.add(n); for (const n of op.unpick) shown.delete(n); }
  };
  const store = {
    has: (no) => shown.has(no),
    /** The picks shown, as a Set (read only). */
    all: () => shown,
    /** Not yet saved: from disk, what differs from the inlined picks; served, nothing (each change is sent). */
    pending: () => o.served ? { pick: [], unpick: [] } : {
      pick: [...shown].filter((n) => !base.has(n)).sort((a, b) => a - b),
      unpick: [...base].filter((n) => !shown.has(n)).sort((a, b) => a - b),
    },
    /** The pending list as the two commands to copy (an empty list gives no command). */
    commands: () => {
      const p = store.pending();
      return [p.pick.length ? "pnpm pick " + p.pick.join(" ") : "", p.unpick.length ? "pnpm unpick " + p.unpick.join(" ") : ""].filter(Boolean);
    },
    /** Whether a clip's shown state is not saved yet (from disk only). */
    unsaved: (no) => !o.served && shown.has(no) !== base.has(no),
    toggle: (no) => (shown.has(no) ? store.change([], [no]) : store.change([no], [])),
    /** Picks then unpicks, one change; returns a promise that settles once it is answered (served). */
    change: (pick, unpick) => {
      const op = { pick: [...pick], unpick: [...unpick] };
      queue.push(op);
      onError(""); // a new change: the last failure has been seen
      recompute(); onChange();
      if (!o.served) return Promise.resolve();
      chain = chain.then(async () => {
        try {
          const single = op.pick.length + op.unpick.length === 1;
          const url = single ? (op.pick.length ? "/pick/" + op.pick[0] : "/unpick/" + op.unpick[0]) : "/picks";
          const r = await doFetch(url, single ? { method: "POST" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pick: op.pick, unpick: op.unpick }) });
          if (!r.ok) throw new Error((await r.text().catch(() => "")) || String(r.status));
          const b = await r.json();
          if (!b || !Array.isArray(b.picks)) throw new Error("the server's answer had no picks");
          confirmed = new Set(b.picks); answered = true;
        } catch (e) {
          onError(e instanceof TypeError ? "The server did not answer: that change was not saved. Is pnpm library still running?" : "Not saved: " + e.message);
        } finally {
          queue.splice(queue.indexOf(op), 1);
          recompute(); onChange();
        }
      });
      return chain;
    },
    /** Served: the server's current picks (a pnpm pick or another tab may have changed them); changes in flight replay on top. */
    load: () => {
      if (!o.served) return Promise.resolve();
      return doFetch("/picks", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((b) => {
        if (!b || !Array.isArray(b.picks) || answered) return; // an answer to a change is newer than this
        confirmed = new Set(b.picks);
        recompute(); onChange();
      }, () => onError("The server did not answer: the picks shown are the ones from when this page was written."));
    },
  };
  return store;
})
