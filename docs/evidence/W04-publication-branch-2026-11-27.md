# W04 publication branch reservation

The managed self-build action creates its reserved GitHub branch at the frozen base before the first turn. This keeps the original CI workflow versions reachable on the branch throughout coding without requiring Workflows write. Publication still requires a completed report, verifies the bundle and pushes the exact reported commit.

The controlled self-build fixture exercises an acknowledged reservation followed by normal publication, a lost creation reply followed by restart, a workflow change on the default branch and one PR, and an incompatible remote reference that blocks the first turn and any second create. The fixture uses a real Git repository and controlled GitHub and Codex peers.
