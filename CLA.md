# Contributor License Agreement (CLA)

> **Version 1.0** — effective 12 August 2026.
>
> This document is versioned on purpose. What you accept is the text of the version named above, not
> whatever this file happens to say later: if the terms are ever revised, the version number is
> raised and earlier acceptances stay bound to the version that was in force when they were given.
> The exact wording of any version can be read out of this repository's history.

This is the Contributor License Agreement for **gnl-framework** (source repository, npm scope
`@gnldev`). It applies to any Contribution (code, documentation, or other material) you submit to
this project, whether by pull request or any other means.

By submitting a Contribution, you agree to the following terms.

## 1. Definitions

- **"Maintainer"** means Karaca Yılmaz (https://gnl.dev), the original author and current copyright holder of the
  Project, and any legal entity Karaca Yılmaz may transfer ownership of the Project to in the
  future (e.g., upon incorporation).
- **"Project"** means the gnl-framework source code and documentation, in this repository and its
  public snapshot.
- **"Contribution"** means any original work of authorship, including modifications to existing
  work, intentionally submitted by you to the Maintainer for inclusion in the Project.

## 2. Grant of Copyright License

You grant the Maintainer **and to recipients of software distributed by the Maintainer** a
perpetual, worldwide, non-exclusive, royalty-free, irrevocable copyright license to reproduce,
prepare derivative works of, publicly display, publicly perform, sublicense, and distribute your
Contribution and derivative works thereof, **including the right to relicense**
the Contribution — alone or as part of the Project — under any license terms the Maintainer chooses,
whether open source, source-available, or proprietary.

This right to relicense is the specific problem this agreement solves: without it, changing the
Project's license later would require tracking down and obtaining consent from every past
contributor, which is impractical at any scale.

## 3. Grant of Patent License

You grant the Maintainer **and to recipients of software distributed by the Maintainer** a
perpetual, worldwide, non-exclusive, royalty-free, irrevocable (except as stated in this section)
patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer your
Contribution, where such license applies only to those patent
claims licensable by you that are necessarily infringed by your Contribution alone or in
combination with the Project. If any entity institutes patent litigation alleging that the
Contribution or the Project infringes a patent, any patent licenses granted to that entity under
this Agreement terminate as of the date such litigation is filed.

## 4. Your Representations

You represent that:

- You are legally entitled to grant the above licenses. If your employer has rights to intellectual
  property you create, you represent that you have received permission to make the Contribution on
  behalf of that employer, or that your employer has waived such rights.
- Each Contribution is your original creation, or you have identified any third-party material and
  its license terms in the Contribution itself.
- You are not aware of any claim that your Contribution infringes a third party's intellectual
  property rights.

## 5. Moral Rights

To the extent any moral rights (e.g., attribution and integrity rights under Turkish Law No. 5846 on
Intellectual and Artistic Works, or equivalent laws elsewhere) in your Contribution cannot be
assigned or waived under applicable law, you agree not to assert such rights against the Maintainer
or downstream users of the Project in a manner that would restrict the licenses granted in
Sections 2 and 3.

## 6. No Obligation, No Warranty

The Maintainer is under no obligation to use or incorporate your Contribution. Your Contribution is
provided "AS IS", without warranty of any kind, consistent with Apache License 2.0 Section 7.

## 7. Governing Law

This Agreement is governed by the laws of the Republic of Türkiye, without regard to its conflict
of law principles.

---

## How this is enforced in practice

You do not need to sign anything separately or in advance. The pull request template carries a
single line:

```
- [ ] I have read and agree to the CLA, v1.0.
```

Ticking that box **is** the acceptance. A workflow (`.github/workflows/cla.yml`) reads the pull
request description and fails its check while the box is unticked, so a change cannot land without
it. No third-party service is involved and no application is granted access to this repository —
the check only reads the description GitHub already hands it.

The acceptance is recorded in the pull request itself: the ticked box, your account and a timestamp
stay with the change for the life of the repository. `CONTRIBUTORS.md` indexes those records. It is
a one-time step per GitHub account; the box is present on every pull request so that each change
carries its own record, but you are only agreeing once.
