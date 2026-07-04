(function wireDemoCheckout() {
  const form = document.getElementById("demo-booking-form");
  if (!form) return;

  function showStep(stepName) {
    document.querySelectorAll("[data-checkout-step]").forEach((step) => {
      step.classList.toggle("is-active", step.dataset.checkoutStep === stepName);
    });
    window.dispatchEvent(new CustomEvent("atw-demo-step", { detail: { step: stepName } }));
  }

  document.addEventListener("click", (event) => {
    const continueButton = event.target.closest("[data-continue-step]");
    if (continueButton) {
      showStep(continueButton.dataset.continueStep);
    }

    if (event.target.closest("[data-demo-add-bag]")) {
      const price = document.querySelector("[data-price]");
      const baggage = document.querySelector("[data-baggage-summary]");
      const baggageSelect = document.querySelector("[name='baggage_option']");
      if (price) price.textContent = "$674.00";
      if (baggage) baggage.textContent = "Cabin bag included. Checked baggage not included.";
      if (baggageSelect) baggageSelect.value = "Cabin bag";
    }

    if (event.target.closest("[data-demo-pay]")) {
      showStep("confirmation");
    }
  });
})();
