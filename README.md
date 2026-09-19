# ResellerHub BD

Multi-role reseller platform prototype (Admin / Reseller / Supplier panels).

## Run locally

No build step. Serve over HTTP (opening files with `file://` breaks image storage):

```bash
python -m http.server 8000
# then open http://127.0.0.1:8000/index.html
```

## Structure

| Path | Role |
| --- | --- |
| `index.html`, `shop.html` | public site |
| `admin/` | admin panel |
| `reseller/` | reseller panel + my-shop |
| `supplier/` | supplier panel |
| `app.js` | shared data layer (localStorage) |
| `backend/` | `steadfast-proxy.php`, `resellerhub-api.php` |

## Notes

- Data is stored per-browser in `localStorage` (keys prefixed `rh_*`), so there is no shared database yet — not multi-user until `backend/resellerhub-api.php` is wired up.
- Development report/preview files (`CHANGES_*`, `PREVIEW_*`, `INVOICE_sample_*`, `DIAGNOSIS_*`, `WHAT_I_CHANGED.html`) are intentionally not committed.
