
1. Bottleneck Fixing: Semantic perception and ownership reconstruction.

Fly sees individual DOM elements, but it does not yet reliably understand how unfamiliar elements combine into one logical checkout component.Working on implementing logical component reconstruction layer where every site observation gets correctly pulled before sending to AI to reason. Currently we are just classifying individual control problem is that most time is not seeing, picking wrong things, as dont have context to it. Currently there are to many layers conflicing and reinterpting smae contorl indepentidly. One layer calls something, another calls navigation, other decision group. We need clear ownership rule where it is:

> The semantic compiler creates the decision contract. Downstream code consumes or validates that contract—it does not reinterpret the raw page again.

2.

### Testing Observations

1. Most or a lot of stuff are hidden like dropdown and so on so we need to test or ensure that if ai doesnt know or sure or if user profile needs to read to return or ask the user or pick the right choice if complex. As we will need to return information live ot user at some point etc.

2. Find the beast frictionless way to move forward. For example seat picking pop up has way to continue click x to close pop up or move forrward dont pick seats both way correct but one way is long other is click x pop up appers to contineu without seats and boom already on the next page while for other need to pick through each page to came ot that same stuff. Ofc if the goal is from user profile that seat picking irrelevant and dont want to pick it etc. of

3. Found on KIWI when testing for example there are dropdown that not requried but need to set correctly for example 12 years or older. Its not reqruired so AI doesnt see it as needs to do it. That has to be fixed....


### Long Term Checklist

- [ ] Test on the multiple checkout on GoToGate reaching payments page
- [ ] Deal with suprieses, diff forms (e.g. How date is entered differently then we have it, Different radio buttons or dropdown, filters, buttons on difference checkouts)
- [ ] Different user profile context actions (Pick seats next to the window, or give me fast checkin and so on)
- [ ] Testing on multiple airlines checkouts tests
(Croatia, Turkish, American and others)
- [ ] Add payments component to solution (credit card fake and everything payment processing wise, FaceID or message verifications)
- [ ] Ensuring minimal close subzero latency making it fast.
- [ ] Ensure making it work in background / cloud / no navigating on screen.
- [ ] Start focusing on UI / UX development once working smooth
(Later / Long term)
- [ ] Focusing on IOS and so on...

### Tests on GoToGate

- [x] Direct Way
- [x] Normal Checking Turkish Eastern EU
- [x] EU International (London, Paris etc.)
- [x] American Traveling
- [x] 2 legs and multi legs
- [x] Half way filled out and so on
- [x] Wrongly inserted data (wrong date, name, radio button or email)
- [x] Wrongly inserted wrong seats and so on.

### Tests Airline Checkouts

Minimum credible test set

Gotogate — existing OTA regression baseline.
Kiwi.com — custom OTA widgets, composite fields and multi-carrier logic.
Turkish Airlines — large international full-service checkout.
Lufthansa — European network-airline flow.
American Airlines or United — US-specific identity, address and phone patterns.
Ryanair — aggressive low-cost seats, baggage and opt-out flows.
Wizz Air or easyJet — second low-cost flow, proving Ryanair fixes were generic.
Emirates or Qatar Airways — international document, nationality and multi-leg patterns.
Singapore Airlines or Korean Air — Asian localisation and different field/control presentation.
One smaller regional airline — less polished and less standardised checkout.
Croatian Airlines

### Type Tests Checkouts

- Half filled information
- Wrong information
- Lacking user profile information
- Spesifc user profile requirments
	-  Seat like window seat
	- Fast checking etc.
	- Added luggage
	- Ambiguity to aks the user
- Non required answers (e.g. above 12 years old)
- Multi user booking

### Tests Search Engines

Skyscanner
Googleflights
KAYAK
