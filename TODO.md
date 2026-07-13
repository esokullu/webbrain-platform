# TODO

## Deferred: Suspend browser sessions as DigitalOcean snapshots

> **Status:** Not planned for implementation now. Keep this proposal for future cost optimization.

Allow a user to stop a browser session without continuing to pay for its running DigitalOcean Droplet. A powered-off Droplet is still billed, so "Stop" would actually:

1. Stop accepting new API runs and finish or abort the active run.
2. Shut Chrome down cleanly and flush the browser profile to disk.
3. Power off the Droplet and create a snapshot.
4. Verify that the asynchronous snapshot operation completed successfully.
5. Delete the original Droplet and mark the logical browser session `suspended`.
6. On resume, create a new Droplet from the snapshot, reconnect it to the existing logical session, wait for the WebBrain extension bridge to become healthy, and mark it `ready`.

### Cost advantage

The typical **Browser** option is DigitalOcean size `s-2vcpu-4gb`:

- 2 vCPUs
- 4 GiB RAM
- 80 GiB SSD
- **$24/month** or approximately **$0.03571/hour** while the Droplet exists, including while it is powered off

Droplet snapshots currently cost **$0.06 per GB per month**, based on snapshot size. If the snapshot were billed at the full 80 GB disk capacity, it would cost at most approximately **$4.80/month** while suspended:

| Stored snapshot size | Snapshot cost/month | Savings versus a $24 Droplet |
| ---: | ---: | ---: |
| 10 GB | $0.60 | $23.40 (97.5%) |
| 20 GB | $1.20 | $22.80 (95%) |
| 40 GB | $2.40 | $21.60 (90%) |
| 80 GB | $4.80 | $19.20 (80%) |

Actual savings depend on the snapshot's billable size and how many hours the resumed Droplet runs. The Droplet continues accruing compute charges until snapshot creation finishes and the Droplet is deleted.

Pricing references:

- [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets)
- [DigitalOcean snapshot pricing](https://docs.digitalocean.com/products/snapshots/details/pricing/)

### Session persistence

This should normally preserve website logins because the Chrome user-data directory lives on the Droplet disk. The snapshot would retain cookies, refresh tokens, local storage, IndexedDB, extension storage, preferences, history, and other persistent profile data.

This is disk restoration, not RAM hibernation. Chrome and WebBrain start as new processes after resume. In-flight runs, WebSockets, memory-only extension state, network connections, and unsaved page state do not survive. Restored websites may also require login again because a token expired or was revoked, or because the replacement Droplet has a different public IP or triggers a site's security checks.

### Required platform changes

- Add a lifecycle such as `ready -> suspending -> suspended -> resuming -> ready`, with explicit failure states and idempotent retries.
- Store the snapshot/image ID, DigitalOcean action ID, suspension time, restore generation, and failure details with the browser session.
- Prevent concurrent runs, deletion, suspension, and resumption operations.
- Never delete the original Droplet until the snapshot has been verified.
- Update the session with the replacement Droplet ID and public IP atomically during resume.
- Use a minimal restore bootstrap instead of rerunning the complete first-install cloud-init script over the snapshotted machine.
- Rotate the platform connection secret and other runtime credentials during resume.
- Regenerate machine identity and SSH host keys cloned by the snapshot.
- Reconcile the snapshotted WebBrain/platform version with the currently supported version before reporting the runtime ready.
- Define separate expiry and retention rules for suspended sessions; the current browser-session TTL must not accidentally delete retained sessions.
- Fail or abort active API runs before suspension because execution state cannot be resumed.

### Risks and operational considerations

- Snapshots contain authenticated browser cookies and must be protected as sensitive credential stores with strict per-user access controls, auditing, retention limits, and secure deletion.
- Snapshot creation and Droplet restoration take time and must be presented as asynchronous operations.
- DigitalOcean capacity may temporarily prevent restoration in the desired region.
- A replacement Droplet normally receives a different public IP, which can trigger website reauthentication even though the browser profile survived.
- Snapshot minimum disk size can prevent resuming onto a smaller Droplet disk.
- Restore must be tested for service startup, extension connectivity, noVNC connectivity, hostname/network configuration, and Chrome profile integrity.
- Keep the snapshot until the replacement runtime is fully healthy; delete it only after a defined rollback window or the next successful suspension.

### Longer-term alternative

For better storage efficiency and simpler upgrades, archive only the quiesced Chrome profile to encrypted object storage and recreate the VM from a clean, current base image. Full-Droplet snapshots are likely the easiest MVP, while profile-only storage is likely the better long-term architecture.
