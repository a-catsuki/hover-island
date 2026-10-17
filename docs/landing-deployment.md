# Public landing page deployment

The static product site lives in `marketing/`. It is deployed separately from
the private Hover Island repository and native application. The production
deployment contains only the site HTML, stylesheet, browser script, three
referenced images, and the signed Windows download at
`downloads/HoverIsland-Windows.zip`.

## Production target

- Vercel team: Pranav's projects (`pranavs-projects-6f0af22f`)
- Project: `hover-island` (`prj_vHt4YCM9IrXTMg28HvOHRGl3FRS3`)
- Deployment: live since 2026-10-17 (`dpl_Gm8ViJVRp9F5yjgFefFXGcQXErkS`, static upload)
- Production URL: https://hover-island.vercel.app

The project is standalone, has no Git connection, and uses static file
deployment. Vercel SSO protection is disabled so the site is public as
requested. Do not add environment variables, application source, deployment
configuration, or repository credentials to the deployment.

## Local checks

- `node --check marketing/script.js`
- Local HTTP preview: `http://127.0.0.1:5173/`
- Download route returned HTTP 200 with `application/zip` and a 5,478,169-byte
  archive during local verification. This was the existing 0.1.4 package and
  is a staging fallback only; production must use the refreshed signed package
  provided for this release.

Before publishing, verify the refreshed archive's signature and hash against
the release record, then verify the production page and download return
successfully. The browser preview is illustrative; the webpage does not
connect to the local Windows app or claim live device data.
