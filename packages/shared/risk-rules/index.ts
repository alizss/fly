import type { BookingContext, BookingWarning } from "../types";

const BAGGAGE_TERMS = [
  "no cabin bag",
  "baggage not included",
  "personal item only",
  "without baggage",
  "checked baggage not included"
];

const MULTI_AIRPORT_CODES = new Set(["LHR", "LGW", "LTN", "STN", "LCY", "CDG", "ORY", "BVA", "IST", "SAW"]);

function addMonths(dateString: string, months: number): Date {
  const date = new Date(dateString);
  date.setMonth(date.getMonth() + months);
  return date;
}

export function runBookingRiskRules(context: BookingContext): BookingWarning[] {
  const warnings: BookingWarning[] = [];
  const pageText = context.pageText.toLowerCase();

  if (context.document?.expiry_date && context.departureDate) {
    const minimumValidThrough = addMonths(context.departureDate, 6);
    if (new Date(context.document.expiry_date) < minimumValidThrough) {
      warnings.push({
        type: "passport_expiry",
        severity: "high",
        title: "Passport expiry risk",
        message: "Passport may expire too soon for this trip."
      });
    }
  }

  if (BAGGAGE_TERMS.some((term) => pageText.includes(term))) {
    warnings.push({
      type: "missing_baggage",
      severity: "medium",
      title: "Baggage may not be included",
      message: "Baggage may not be included."
    });
  }

  if (context.previousPrice && context.detectedPrice && context.detectedPrice.amount > context.previousPrice.amount * 1.03) {
    warnings.push({
      type: "price_changed",
      severity: "medium",
      title: "Price changed",
      message: "Final price appears higher than earlier detected price."
    });
  }

  if (
    context.formName &&
    ((context.formName.firstName && context.formName.firstName.toLowerCase() !== context.traveler.first_name.toLowerCase()) ||
      (context.formName.lastName && context.formName.lastName.toLowerCase() !== context.traveler.last_name.toLowerCase()))
  ) {
    warnings.push({
      type: "name_mismatch",
      severity: "high",
      title: "Name mismatch",
      message: "Passenger name may not match saved travel document."
    });
  }

  if (context.destinationAirport && MULTI_AIRPORT_CODES.has(context.destinationAirport)) {
    warnings.push({
      type: "multiple_airport",
      severity: "low",
      title: "Confirm airport",
      message: "This city has multiple airports. Confirm the correct airport."
    });
  }

  return warnings;
}
