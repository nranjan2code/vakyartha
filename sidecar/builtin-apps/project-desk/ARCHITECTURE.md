# Project Activity Desk: architecture

## File map
server.ts validates repository input/source records, owns refresh and local triage, and updates every view. surface.json defines Triage, Activity and Source ledger. app.json declares the governed read tool and opt-in trigger. README.md owns setup/use/data limits; AGENTS.md owns maintenance invariants; SKILLS.md maps relevant procedures. Those documents travel with source and reviewed publication.

## Canonical data and projections
context.state.issues, pulls and commits own their respective source samples. context.state.triage is the independent local lane mapping keyed by validated issue URL. Controls and receipts share app state.

## Runtime flow
Visible control → current-revision serialized app dispatch → disposable supervised sandbox → validated domain inputs and permitted integration/SQL → independent canonical Projection updates → atomic app record commit → visible/spoken projections. This uses the existing app host and integration lifecycle; there is no domain renderer, native relay or separate connector.

## Data/network boundaries
The exact tool is web__fetch_page through Web pages. Only credential-free public repository HTTPS API reads are made. Configure owner/repository; the default is nranjan2code/vakyartha. Enable Web pages and allow fetch_page. Private repositories/authentication are outside this reference; use an appropriate existing integration for a separately designed private workflow.

Optional 15-minute polling while the host/computer are running and awake; publication disables it. Missed minutes are skipped. Partial failures retain prior datasets for the same repository and report their failed receipts. No background mutation or notification is performed.

## Failure, persistence and evolution
The app host is the only persistent writer. Failed invocation or invalid projection retains committed state; external uncertainty is never automatically replayed. Domain schema changes require an explicit compatibility/migration design, not a user-data reset. Runtime bounds remain 30-second invocations, bounded tool/response sizes and the opted-in database snapshot bound where relevant. General CPU/RSS/disk quotas and permanent app daemons are not promised.

## Extension decisions and verification
Keep source parsing/calculation/product behavior in this package. Reuse the existing integrations and standard Projection components. A missing general visual/binding capability belongs in Projection's own repository, not a package-specific surface patch. Independently check issue/PR distinction, configured repository identity, SHA, counts and timestamps against public source JSON. Verify local lane changes survive source refresh/reopen without any remote write call. Check repository changes clear old records, malformed/unsafe source identities fail, and empty arrays are valid zero-record samples.

No remote issue edits, assignment, delivery prediction, exhaustive pagination, CI-health claim, private token forwarding or full backlog/throughput analytics. Native board moves are local app state.
