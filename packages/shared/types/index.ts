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
  date_of_birth: string;
  gender?: string;
  nationality: string;
  email: string;
  phone: string;
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
