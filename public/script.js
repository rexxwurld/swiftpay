document.addEventListener("DOMContentLoaded", function () {

  /* =====================================================
     HAMBURGER MENU
  ===================================================== */
  const menuIcon = document.getElementById("menuIcon");
  const navLinks = document.getElementById("navLinks");

  if (menuIcon && navLinks) {
    menuIcon.addEventListener("click", function (event) {
      event.stopPropagation();
      menuIcon.classList.toggle("active");
      navLinks.classList.toggle("active");
    });

    navLinks.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        menuIcon.classList.remove("active");
        navLinks.classList.remove("active");
      });
    });

    document.addEventListener("click", function (event) {
      if (!navLinks.contains(event.target) && !menuIcon.contains(event.target)) {
        navLinks.classList.remove("active");
        menuIcon.classList.remove("active");
      }
    });
  }

  /* =====================================================
     SMOOTH SCROLL
  ===================================================== */
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (event) {
      const targetId = this.getAttribute("href");
      if (!targetId || targetId === "#") return;

      const target = document.querySelector(targetId);
      if (target) {
        event.preventDefault();
        const navbarHeight = 64;
        const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - navbarHeight;
        window.scrollTo({ top: targetPosition, behavior: "smooth" });
      }
    });
  });

  /* =====================================================
     DEVELOPER CODE SAMPLES
  ===================================================== */
  const codeSamples = {
    CURL: `curl -X POST https://checkout-rexxpay.onrender.com/api/v1/payments \\
  -H "Authorization: Bearer YOUR_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": 5000,
    "currency": "NGN",
    "email": "customer@example.com",
    "reference": "ORDER-12345"
  }'`,

    Node: `const axios = require("axios");

const response = await axios.post(
  "https://checkout-rexxpay.onrender.com/api/v1/payments",
  {
    amount: 5000,
    currency: "NGN",
    email: "customer@example.com",
    reference: "ORDER-12345"
  },
  {
    headers: {
      Authorization: "Bearer YOUR_SECRET_KEY",
      "Content-Type": "application/json"
    }
  }
);

console.log(response.data);`,

    Dotnet: `using System.Net.Http;
using System.Text;
using System.Text.Json;

var client = new HttpClient();

client.DefaultRequestHeaders.Add(
    "Authorization",
    "Bearer YOUR_SECRET_KEY"
);

var payload = new
{
    amount = 5000,
    currency = "NGN",
    email = "customer@example.com",
    reference = "ORDER-12345"
};

var json = JsonSerializer.Serialize(payload);

var content = new StringContent(
    json,
    Encoding.UTF8,
    "application/json"
);

var response = await client.PostAsync(
    "https://checkout-rexxpay.onrender.com/api/v1/payments",
    content
);

Console.WriteLine(
    await response.Content.ReadAsStringAsync()
);`,

    Python: `import requests

url = "https://checkout-rexxpay.onrender.com/api/v1/payments"

headers = {
    "Authorization": "Bearer YOUR_SECRET_KEY",
    "Content-Type": "application/json"
}

data = {
    "amount": 5000,
    "currency": "NGN",
    "email": "customer@example.com",
    "reference": "ORDER-12345"
}

response = requests.post(
    url,
    headers=headers,
    json=data
)

print(response.json())`
  };

  /* =====================================================
     CODE DISPLAY
  ===================================================== */
  const codeContent = document.querySelector(".code-content");
  const copyButton = document.querySelector(".copy-btn");
  const languageButtons = document.querySelectorAll(".bodychild1in1 button[data-lang]");

  if (codeContent) {
    codeContent.textContent = codeSamples.CURL;
  }

  const curlButton = document.querySelector('.bodychild1in1 button[data-lang="CURL"]');
  if (curlButton) {
    curlButton.classList.add("active-btn");
  }

  languageButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      const language = this.getAttribute("data-lang");
      const code = codeSamples[language];

      if (!code) {
        console.error("Code sample not found for:", language);
        return;
      }

      if (codeContent) {
        codeContent.textContent = code;
      }

      languageButtons.forEach(function (btn) {
        btn.classList.remove("active-btn");
      });

      this.classList.add("active-btn");
    });
  });

  /* =====================================================
     COPY CODE
  ===================================================== */
  if (copyButton) {
    copyButton.addEventListener("click", async function () {
      if (!codeContent) return;

      const code = codeContent.textContent.trim();
      if (!code) return;

      try {
        await navigator.clipboard.writeText(code);
        this.textContent = "Copied ✓";
        const button = this;
        setTimeout(function () {
          button.textContent = "Copy";
        }, 1500);
      } catch (error) {
        console.error("Unable to copy code:", error);

        const textArea = document.createElement("textarea");
        textArea.value = code;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        textArea.style.top = "-999999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        try {
          document.execCommand("copy");
          this.textContent = "Copied ✓";
        } catch (fallbackError) {
          console.error("Fallback copy failed:", fallbackError);
          this.textContent = "Copy failed";
        }

        document.body.removeChild(textArea);
        const button = this;
        setTimeout(function () {
          button.textContent = "Copy";
        }, 1500);
      }
    });
  }

  /* =====================================================
     CONTACT FORM
  ===================================================== */
  const contactForm = document.querySelector(".body7only2 form");

  if (contactForm) {
    const submitButton = contactForm.querySelector('button[type="button"]');
    const message = contactForm.querySelector(".form-message");

    if (submitButton) {
      submitButton.addEventListener("click", function () {
        contactForm.reset();

        if (message) {
          message.textContent = "Request submitted successfully ✅";
          message.style.display = "block";
          setTimeout(function () {
            message.style.display = "none";
          }, 3000);
        }
      });
    }
  }

  /* =====================================================
     PRICING PLAN SELECTION
  ===================================================== */
  const pricingButtons = document.querySelectorAll(".pricing-btn");

  pricingButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      const href = this.getAttribute("href");
      if (!href) return;

      try {
        const url = new URL(href, window.location.origin);
        const plan = url.searchParams.get("plan");

        if (plan) {
          localStorage.setItem("selectedPlan", plan);
        }
      } catch (error) {
        console.error("Unable to read pricing plan:", error);
      }
    });
  });

  /* =====================================================
     FOOTER YEAR
  ===================================================== */
  const footerText = document.querySelector(".footer-bottom span");

  if (footerText) {
    footerText.textContent = `©️ ${new Date().getFullYear()} SwiftPay. All rights reserved.`;
  }

  console.log("SwiftPay frontend JavaScript loaded successfully.");

});
