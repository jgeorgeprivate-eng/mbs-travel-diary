# Pilot test plan

Suggested group: you (admin), one EA or travel arranger, two frequent travellers, one line manager who is not also a traveller, and one contractor's details entered by the EA. Run for three to four weeks with real upcoming trips.

## Before the group starts

1. Sign in as admin. Confirm the dashboard loads and the Checks table is empty.
2. People: add the pilot group with cost centres, line manager emails and roles. Add one contractor without an email.
3. Smartraveller: confirm countries show colours in the day grid (type "Sing" in a country field and pick Singapore from the list).

## Scenarios to try

| # | Who | What | Expect |
|---|---|---|---|
| 1 | Traveller | Log a 5-day trip to one country, all working days qualifying, declare approval | Submitted; appears on dashboard as dashed; manager sees it under Approvals |
| 2 | Manager | Approve scenario 1 with a comment | Bar becomes solid; traveller sees the comment on the trip |
| 3 | Traveller | Log a 7-day trip with only 2 qualifying days | Summary shows "Below the business activity 50% test"; submits anyway; flagged in Checks and in the approval queue |
| 4 | Traveller | Edit an approved trip and change the end date | Status returns to Awaiting approval; manager sees it again |
| 5 | Traveller | Edit an approved trip and change only a hotel name | Stays approved |
| 6 | EA | Log a trip for the contractor, two countries, one stay not paid by MBS | Appears under the contractor's name with "entered by"; dashboard shows the right country on each date |
| 7 | Traveller | Enter a level 3 country (e.g. Israel at the time of writing; check the list) | Dean permission declaration appears; submit is refused until it is ticked |
| 8 | Traveller | Enter a level 4 country | Submit button disabled with the policy message |
| 9 | Traveller | Mark a Melbourne public holiday during the trip | Weekday count in the summary drops by one |
| 9a | Traveller | Mark two days of a trip as Leave | Trip carries a "leave days abroad" flag in Checks, Trips and the approval queue |
| 10 | Anyone | On a phone, tick boxes and change day types on a long trip | Page stays where you were; no jump to the top |
| 11 | Traveller (role traveller) | Open Trips | Sees only own trips; no "Everyone else" section |
| 12 | Manager | Dashboard, pick a cost centre | Country cards, timeline and Checks filter to that cost centre |
| 13 | Admin | Dashboard, pick a date three weeks out | Shows who will be away on that day with mobiles |
| 14 | Admin | Approvals | Sees trips waiting on other managers and can approve them |
| 15 | New staff member | Sign in with an MBS address not yet on People | Gets in as a traveller; appears on People; admin sets cost centre and manager |
| 16 | Outsider | Sign in with a non-MBS address not on People | Link is refused |

## Things to record during the pilot

- How long a traveller takes to log a typical trip, and which fields they skip or get wrong.
- Whether managers notice trips waiting without an email nudge, and how long approvals take.
- Any country names people type that do not match the Smartraveller list.
- Whether the "could not have been done from Melbourne" tick is understood the same way by everyone.
- Which dashboard view the CFO's office actually opens.

## Decisions to make at the end

- Email notifications for approvals (needs a sending domain).
- Microsoft sign-in instead of email links (needs IT to register the app).
- The AI itinerary reader.
- Whether to move the hosting into the MBS Azure tenant, keep it here, or rebuild in Power Apps now that the rules are settled.
