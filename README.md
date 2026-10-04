# website-data

Large static files for evaluatedapplications.github.io (council spending data, Prism model checkpoints, the prebuilt Blazor runtime), served by GitHub Pages at https://evaluatedapplications.github.io/website-data/ (same origin as the site, so no CORS).

| Folder | What | Written by |
|---|---|---|
| `council-web/` | Council Spending Scanner data (phone-sized slices) | `AboutUs/CouncilWebBuilder` (`dotnet run -c Release --project CouncilWebBuilder`) |
| `prism/` | Prism checkpoint (`oracle-brain.bin.gz`) and its sidecars, read by Prism, Nano Stories, The Cartographer, The Analyst, Prose | the Prism checkpoint refresh |
| `_framework/` | The Blazor WebAssembly runtime for `/tools` (hash-named files, plain, no `.br`/`.gz`) | `AboutUs/Showroom/scripts/publish-site.ps1` |

Push this repo BEFORE the site repo (the site's `index.html` fetches hashed runtime files from here). `.gitattributes` is `* -text -diff`: nothing here may be line-ending converted.

Council spending data: Open Government Licence v3.0, credit to each council. Everything else (c) Evaluated Applications.