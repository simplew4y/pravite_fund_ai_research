"use strict";

async function readSessionActivity(fetchImpl, serverUrl) {
  let after = "";
  try {
    for (;;) {
      const params = new URLSearchParams({
        order: "desc",
        sort_by: "updated_at",
        limit: "100",
        include_archived: "true",
      });
      if (after) params.set("after", after);
      const response = await fetchImpl(
        `${serverUrl.replace(/\/+$/, "")}/v1/sessions?${params.toString()}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const page = await response.json();
      if (Array.isArray(page?.data) && page.data.some((item) => item?.status === "running")) {
        return {
          applying: false,
          busy: true,
          detail: "当前有回答正在生成，请等待完成后修改。",
        };
      }
      if (!page?.has_more || !page?.last_id) break;
      after = String(page.last_id);
    }
    return { applying: false, busy: false };
  } catch (error) {
    return {
      applying: false,
      busy: true,
      detail: `无法确认当前生成状态：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

module.exports = { readSessionActivity };
