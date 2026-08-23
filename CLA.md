# Contributor License Agreement (CLA)

> **Version 1.1** — effective 23 August 2026.
>
> This document is versioned on purpose. What you accept is the text of the version named above, not
> whatever this file happens to say later: if the terms are ever revised, the version number is
> raised and earlier acceptances stay bound to the version that was in force when they were given.
> The exact wording of any version can be read out of this repository's history.
>
> **Changes from 1.0** (12 August 2026): section 4 no longer asks a contributor to indemnify the
> Maintainer for losses arising from an inaccurate representation, and asks instead to be told when
> one turns out to be inaccurate. The change was made on 17 August in the commit that rewrote that
> section, and it is recorded here because the version number should have moved with it and did not —
> the paragraph above promises exactly that, and this is the correction. No acceptance was affected:
> every commit in this repository to date is the Maintainer's own, so no one had accepted 1.0.

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

You consent in advance, and irrevocably, to the Maintainer transferring the rights and licences
granted here to a legal entity the Maintainer controls or which is the Maintainer's successor —
typically a company formed to hold the Project. Turkish law (Law No. 5846, Article 49) requires the
author's written consent before a licence obtained from them is passed on, and this paragraph is
that consent: without it, incorporating the Project later would mean asking every past contributor
again, which is the exact problem this Agreement exists to avoid.

If that consent is held ineffective for any reason, the Maintainer's authority to sublicense under
Section 2 stands on its own and is unaffected.

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

For the purposes of Turkish law, which governs this Agreement under Section 7, the licence granted
above covers each of the following economic rights under Law No. 5846 on Intellectual and Artistic
Works **separately and individually**, as Article 52 of that Law requires:

- **Article 21** — the right of adaptation (*işleme hakkı*)
- **Article 22** — the right of reproduction (*çoğaltma hakkı*)
- **Article 23** — the right of distribution (*yayma hakkı*)
- **Article 24** — the right of performance (*temsil hakkı*)
- **Article 25** — the right of communication to the public and of making available by means of
  devices enabling the transmission of signs, sounds and/or images (*işaret, ses ve/veya görüntü
  nakline yarayan araçlarla umuma iletim ve erişime sunma hakkı*) — this is the right under which
  the Project is published to package registries and served over the internet

The licence is granted for an unlimited term and without territorial restriction.

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
  behalf of that employer, or that your employer has waived such rights. Note that under Turkish
  law (Law No. 5846, Article 18/2) an employer exercises the economic rights in work an employee
  creates in the course of their duties — so if you are contributing work made on an employer's
  time, it is your employer, not you, who is able to grant the licence in Section 2.
- Each Contribution is your original creation, or you have identified any third-party material and
  its license terms in the Contribution itself.
- You are not aware of any claim that your Contribution infringes a third party's intellectual
  property rights.

You agree to notify the Maintainer of any facts or circumstances you become aware of that would make
these representations inaccurate in any respect. This matters because a licence granted by someone
who was not entitled to grant it conveys nothing: the Maintainer would have to remove the
Contribution from every published version, and that is far cheaper the sooner it is known.

There is deliberately no indemnity here. An honest mistake about what you were entitled to grant is
not something a weekend contribution should carry unlimited liability for, and the Maintainer's real
need is early notice, not a claim. This matches the Apache ICLA, which asks for the same notice and
imposes no indemnification.

## 5. Moral Rights

To the extent any moral rights (e.g., attribution and integrity rights under Turkish Law No. 5846 on
Intellectual and Artistic Works, or equivalent laws elsewhere) in your Contribution cannot be
assigned or waived under applicable law, you agree not to assert such rights against the Maintainer
or downstream users of the Project in a manner that would restrict the licenses granted in
Sections 2 and 3.

Where Turkish law permits it (Law No. 5846, Article 19), you additionally grant the Maintainer the
authority to exercise the rights under Articles 14 (disclosure to the public), 15 (attribution) and
16/1 (modification) on your behalf.

Attribution is not something this Agreement asks you to give up. Your name stays on your work: the
commit history records it permanently, and `CONTRIBUTORS.md` names you. The Maintainer treats that
record as how the attribution right is honoured, not waived.

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
- [ ] I have read and agree to the CLA, v1.1.
```

Ticking that box **is** the acceptance. A workflow (`.github/workflows/cla.yml`) reads the pull
request description and fails its check while the box is unticked, so a change cannot land without
it. No third-party service is involved and no application is granted access to this repository —
the check only reads the description GitHub already hands it.

The acceptance is recorded in the pull request itself: the ticked box, your account and a timestamp
stay with the change for the life of the repository. `CONTRIBUTORS.md` indexes those records. It is
a one-time step per GitHub account; the box is present on every pull request so that each change
carries its own record, but you are only agreeing once.
