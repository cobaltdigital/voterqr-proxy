---
title: Core Web Vitals thresholds for client sites
domain: web_design
type: sop
status: current
owner: web team
tags: [core web vitals, lcp, performance]
---

# Core Web Vitals thresholds for client sites

Every client site we build or maintain is held to the same Core Web Vitals bar on mobile,
measured on field data (CrUX / PageSpeed Insights), not lab scores.

- LCP under 2.5s on mobile for all templated landing pages.
- INP under 200ms.
- CLS under 0.1.

Check the page speed report before and after any layout change, and record the result as a
site-change record so the before/after is attributable.
