import type { SiteMapping } from "../types";

export const demoCheckoutMapping: SiteMapping = {
  siteId: "demo-checkout",
  hostPatterns: ["localhost:4173"],
  fieldSelectors: {
    firstName: ["[name='first_name']"],
    lastName: ["[name='last_name']"],
    dateOfBirth: ["[name='date_of_birth']"],
    nationality: ["[name='nationality']"],
    passportNumber: ["[name='passport_number']"],
    passportExpiry: ["[name='passport_expiry']"],
    billingCompany: ["[name='billing_company']"],
    billingTaxId: ["[name='billing_tax_id']"],
    billingEmail: ["[name='billing_email']"],
    billingAddress: ["[name='billing_address']"],
    email: ["[name='email']"],
    phone: ["[name='phone']"]
  },
  priceSelectors: ["[data-price]"],
  baggageTextSelectors: ["[data-baggage-summary]"],
  tripSummarySelectors: {
    origin: ["[data-origin]"],
    destination: ["[data-destination]"],
    departureDate: ["[data-departure]"],
    airline: ["[data-airline]"],
    bookingReference: ["[data-booking-reference]"]
  }
};

export const genericFieldTerms = {
  firstName: ["first", "given", "forename"],
  lastName: ["last", "surname", "family"],
  passportNumber: ["passport", "document number", "travel document"],
  dateOfBirth: ["birth", "date of birth", "dob"],
  nationality: ["nationality", "citizenship"],
  passportExpiry: ["expiry", "expiration"],
  billingCompany: ["billing company", "invoice company", "company name", "legal name"],
  billingTaxId: ["tax id", "vat", "tax number"],
  billingEmail: ["billing email", "invoice email"],
  billingAddress: ["billing address", "invoice address"],
  email: ["email"],
  phone: ["phone", "mobile", "telephone"]
};
