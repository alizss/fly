export type WorkspaceRole = "owner" | "admin" | "member";
export type TripStatus = "draft" | "booked" | "cancelled" | "completed";
export type InvoiceStatus = "missing" | "received" | "not_required";

export type Money = {
  amount: number;
  currency: string;
};

export type TravelerProfile = {
  id: string;
  workspace_id: string;
  first_name: string;
  middle_name?: string;
  last_name: string;
  second_last_name?: string;
  date_of_birth: string;
  place_of_birth?: string;
  gender?: string;
  nationality: string;
  country_of_residence?: string;
  email: string;
  phone: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  frequent_flyer_program?: string;
  frequent_flyer_number?: string;
  known_traveler_number?: string;
  redress_number?: string;
  emergency_contact_name?: string;
  emergency_contact_relationship?: string;
  emergency_contact_phone?: string;
  emergency_contact_email?: string;
  meal_preference?: string;
  special_assistance?: string;
  travel_purpose?: "leisure" | "business";
  preferred_seat: "aisle" | "window" | "no preference";
  baggage_preference: "personal item" | "cabin bag" | "checked bag";
  default_cabin: "economy" | "business";
  invoice_company?: string;
  billing_tax_id?: string;
  billing_address?: string;
  billing_email?: string;
  payment_preference?: "browser saved card" | "Apple Pay / Google Pay" | "company virtual card" | "manual payment";
};

export type TravelerDocument = {
  id: string;
  traveler_profile_id: string;
  document_type: "passport" | "national ID";
  issuing_country: string;
  issue_date?: string;
  encrypted_document_number: string;
  document_number_last4: string;
  expiry_date: string;
};

export type BookingContext = {
  traveler: TravelerProfile;
  document?: TravelerDocument;
  pageText: string;
  detectedPrice?: Money;
  previousPrice?: Money;
  departureDate?: string;
  originAirport?: string;
  destinationAirport?: string;
  sellerHost?: string;
  baggageSummary?: string;
  formName?: {
    firstName?: string;
    lastName?: string;
  };
};

export type BookingWarning = {
  type: string;
  severity: "low" | "medium" | "high";
  title: string;
  message: string;
};

export type SiteMapping = {
  siteId: string;
  hostPatterns: string[];
  fieldSelectors: {
    firstName?: string[];
    lastName?: string[];
    dateOfBirth?: string[];
    nationality?: string[];
    passportNumber?: string[];
    passportExpiry?: string[];
    billingCompany?: string[];
    billingTaxId?: string[];
    billingEmail?: string[];
    billingAddress?: string[];
    email?: string[];
    phone?: string[];
  };
  priceSelectors?: string[];
  baggageTextSelectors?: string[];
  tripSummarySelectors?: {
    origin?: string[];
    destination?: string[];
    departureDate?: string[];
    returnDate?: string[];
    airline?: string[];
    bookingReference?: string[];
  };
};
