---
status: accepted
---

# Use iFinD-first field-level valuation data

The valuation monitoring context will connect directly to the official iFinD HTTP API through a dedicated `IFindHttpMarketDataProvider`. The first release validates A-share financial and market observations; Hong Kong support remains deferred until licensed response samples are available. iFinD is preferred per metric, while missing, unauthorized, or failed fields fall back independently to existing providers; the generic normalized `HttpMarketDataProvider` remains a separate integration boundary.

The five-metric contract is provider-independent: shared domain calculations derive metric changes and rolling averages, financial observations retain reporting and disclosure dates, market observations use the valuation date, currency mismatches suppress gap calculations, and stale or period-mismatched values never trigger alerts. The first release reads a locally maintained access token and treats `ths_amt_stock` as CNY yuan without frontend conversion. Append-only sanitized source snapshots preserve provenance without persisting authentication material; automatic refresh-token handling is deferred.
