# Trading plan review

The existing real-money workspace order draft now groups server-calculated evidence into mode/account, entry/exit, spending/costs and approval/next-step sections. Detailed calculations and public market evidence remain expandable; blockers and warnings remain visible.

This is a single buy-limit draft, not an automated strategy or a paper execution. Account binding, balance, actual fees and execution eligibility are not inferred. Zero assumed fees stay labeled as assumptions. A drafted stop is not armed and loss-to-stop is not a maximum loss guarantee. Passing a notional cap or public market checks never grants authority.

Input changes and existing server-derived review expiry invalidate the displayed review. No new endpoint, MCP tool, storage, credential access, order or approval is introduced. All existing live launch gates remain unchanged.
