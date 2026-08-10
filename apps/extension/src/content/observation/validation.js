export function actionableCheckoutErrors(errors = []) {
  return (errors || [])
    .map((error) => String(typeof error === "string" ? error : error?.message || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((error) => !/no seat map available|not possible to reserve seats|requested random seating/i.test(error));
}
