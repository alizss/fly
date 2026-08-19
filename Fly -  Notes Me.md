# Fly -  Notes Me 

Criteria

> Only way stoping is something completely spesifc to that site. It should be able to finish and
> complete airline randomly added. It should deal and reason, figure it out, deal with unfamilliar 
> widgets, controls, accutators, strucutre of the website.* 
## Macro Checklist

- [x] Test on the multiple checkout on GoToGate reaching payments page
- [x] Deal with suprieses, diff forms (e.g. How date is entered differently then we have it, Different radio buttons or dropdown, filters, buttons on difference checkouts)
- [x] Different user profile context actions (Pick seats next to the window, or give me fast checkin and so on)
- [x] Testing on multiple airlines checkouts tests(Croatia, Turkish, and others)
- [x] Simplify the codebase remove all conflicting code, constraining and preventing flexibility of solution.  (content.js over 18k lines of code need to organize this)
- [x] Simplify and update the documenation 
- [x] Implemeneting component to understand the page semanticly, where at, what has to be done, what else needs to be done. (For example not requried age +18, our AI has to understand that even if not reqruired or correct way to enter the phone number etc. )
- [ ] Find way to live test faster, it has to be eeither done automaticly takes to long time after each change to test live. Either agent or better regressions. 
- [ ] Making it work on the Croatia Airlines fixing and reaching the payment page recognizing it. 
  - [ ] Ensure it works also other existing ones.
- [ ] Able to deal with unfamiliar controls, dropdown its has to be able to work it out figure it out. Has to be able to deal with unfamiliarity. Has to be able to find and best way to reach its goal. If dropdown has text field, don't scroll, type it, doesn't work, try different value and so on. 
- [ ] Build exact error-driven recovery (When it fails reasons, plans doesn't randomly try or test something irrelevant like randomly clicking)
- [ ] Preserve task continuity across navigation (Has to know where it's in the process)
- [ ] Test on top 10 airlines in EU and US reaching payment page with no errors.
- [ ] Add random airline you find and has to be able to reach it's goal without stopping. 
- [ ] Able to adapt to the spesifc new user profiles (like booking spesifc seat, adding fast checkins or group booking, return information eg. they have this as addons etc.)
- [ ] Add payments component (credit card fake and everything payment processing wise, FaceID or message verifications)
---
- [ ] Optimizing minimal close subzero latency making it fast.
- [ ] Ensure making it work in background / cloud / no navigating on screen.
- [ ] Start focusing on UI / UX development once working smooth for chrome extensions and web page.
- [ ] Focusing on IOS app ux and ui inital features. 


### Comments 


1. Find the beast frictionless way to move forward. For example seat picking pop up has way to continue click x to close pop up or move forrward dont pick seats both way correct but one way is long other is click x pop up appers to contineu without seats and boom already on the next page while for other need to pick through each page to came ot that same stuff. Ofc if the goal is from user profile that seat picking irrelevant and dont want to pick it etc. of

2. Found on KIWI when testing for example there are dropdown that not requried but need to set correctly for example 12 years or older. Its not reqruired so AI doesnt see it as needs to do it. That has to be fixed....
### 
### Tests Airline Checkouts & OTEs

Minimum credible test set

Turkish Airlines — large international full-service checkout.
Lufthansa — European network-airline flow.
American Airlines or United — US-specific identity, address and phone patterns.
Ryanair — aggressive low-cost seats, baggage and opt-out flows.
Wizz Air or easyJet — second low-cost flow, proving Ryanair fixes were generic.
Emirates or Qatar Airways — international document, nationality and multi-leg patterns.
Singapore Airlines or Korean Air — Asian localisation and different field/control presentation.
One smaller regional airline — less polished and less standardised checkout like Croatian Airlines

---

Blind batch 1 — 15 sites
European direct airlines
1. Lufthansa — traditional full-service network checkout.
2. Ryanair — ancillary-heavy low-cost checkout.
3. Wizz Air — custom SPA controls and memberships.
4. British Airways — full-service fare and passenger flow.
5. airBaltic — regional airline with bundles and extras.
6. Aegean Airlines — regional/full-service passenger flow.
Non-European network and long-haul
7. Delta — US Secure Flight/passenger structure.
8. United — US network airline and complex fare structures.
9. Emirates — long-haul documents and ancillary flow.
10. Qatar Airways — long-haul booking flow.
11. Singapore Airlines — another independent long-haul family.
Structurally different OTAs
12. Trip.com — large international OTA.
13. eDreams — ancillary/subscription-heavy OTA.
14. Expedia Flights — mainstream OTA structure.
15. Booking.com Flights — another OTA frontend/supplier structure.
The linked official booking entry points are currently available; for example, Lufthansa, Ryanair, Wizz and British Airways expose direct flight search, while Trip.com and eDreams expose active flight booking products. Lufthansa, Ryanair, Trip.com, eDreams.

### Type Tests Checkouts

- Half filled information
- Wrong information
- Lacking user profile information
- Spesifc user profile requirments
	-  Seat like window seat
	- Fast checking etc.
	- Added luggage
	- Ambiguity to ask the user
- Non required answers (e.g. above 12 years old)
- Multi user booking

