"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJsonCached } from "@/lib/client-data-cache";

// These views share bounded reads and ignore responses for an older filter.
export function useFeatureResource<T>(url: string | null, datasets: string) {
  const [state, setState] = useState<{ url: string | null; data: T | null; response: T | null; loading: boolean; error: boolean }>({ url, data: null, response: null, loading: !!url, error: false });
  const sequence = useRef(0);
  const load = useCallback((force = false) => {
    if (!url) return;
    const request = ++sequence.current;
    return fetchJsonCached<T>(url, { staleMs: 30_000, force }).then(data => {
      if (sequence.current === request) setState(previous => ({
        url,
        // A warm-cache focus read returns the same object. Preserve pages the
        // user appended locally until an actual server response replaces it.
        data: previous.url === url && previous.response === data ? previous.data : data,
        response: data, loading: false, error: false,
      }));
    }).catch(() => {
      if (sequence.current === request) setState(previous => ({ url, data: previous.url === url ? previous.data : null, response: previous.url === url ? previous.response : null, loading: false, error: true }));
    });
  }, [url]);
  useEffect(() => {
    if (!url) return;
    const requests = sequence;
    void load();
    let changedWhileHidden = false;
    const changed = (event: Event) => {
      const changedDatasets = (event as CustomEvent<{ datasets?: string[] }>).detail?.datasets;
      if (changedDatasets && !changedDatasets.some(dataset => datasets.split(",").includes(dataset))) return;
      if (document.visibilityState === "hidden") { changedWhileHidden = true; return; }
      void load(true);
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      void load(changedWhileHidden);
      changedWhileHidden = false;
    };
    window.addEventListener("club-data-updated", changed);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => {
      requests.current++;
      window.removeEventListener("club-data-updated", changed);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", visible);
    };
  }, [url, datasets, load]);
  const updateData = useCallback((updater: (data: T) => T) => {
    setState(previous => previous.url === url && previous.data ? { ...previous, data: updater(previous.data) } : previous);
  }, [url]);
  const data = url && state.url === url ? state.data : null;
  return { data, updateData, loading: !!url && (state.url !== url || state.loading), error: state.url === url && state.error, reload: () => {
    setState(previous => ({ url, data: previous.url === url ? previous.data : null, response: previous.url === url ? previous.response : null, loading: true, error: false }));
    return load(true);
  } };
}
