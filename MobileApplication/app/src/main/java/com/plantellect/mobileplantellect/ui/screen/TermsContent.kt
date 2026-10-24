package com.plantellect.mobileplantellect.ui.screen

/** One block of the Terms & Conditions. Mirrors the text in public/auth.html; update both together. */
data class TermsSection(val heading: String, val body: String)

val termsSections: List<TermsSection> = listOf(
    TermsSection("Date of Effect: September 26, 2026",
        "Plantellect Development Team"),
    TermsSection("1. Overview and Age Limitations",
        "Greetings from Plantellect! Your use of our web application, including any material," +
                " features, and services provided by our platform, is governed by these terms " +
                "and conditions. You accept these terms by registering, using, or gaining access to Plantellect. " +
                "Please do not use our application if you disagree with any of these terms. Additionally, in order to " +
                "create an account and utilize our platform, users must be at least 13 years old " +
                "(or the minimum legal age of digital consent in their local jurisdiction). " +
                "You certify that you are of legal age by using Plantellect."),
    TermsSection("2. Definitions",
        "The following definitions of important terminology used in this text will aid in " +
                "your understanding of these terminology and Conditions:" +
                "\n- \"Application,\" \"Plantellect,\" \"We,\" \"Us,\" or \"Our\" refer to the " +
                "Plantellect web application, its developers, administrators, and operating team." +
                "\n- \"User,\" \"You,\" or \"Your\" refers to the person using, registering, or " +
                "interacting with the Plantellect application.\n- \"Account\" refers to the special " +
                "profile and secure dashboard that a user creates in order to access Plantellect's " +
                "primary features.\n- \"Content\" refers to text, software, scripts, graphics, " +
                "photos, plant care notes, and other materials that are uploaded, downloaded, or " +
                "appear on the application."),
    TermsSection("3. User Enrollment and Information Gathering",
        "You must create an account with correct, up-to-date, and comprehensive information " +
                "in order to use Plantellect. In particular, we will request and gather some " +
                "personal information throughout the registration and account setup process " +
                "(such as Full Name, Email Address, Contact Number, and Account Password), " +
                "which we will use purely and exclusively for the administration, operation, " +
                "and functionality of the Plantellect application."),
    TermsSection("4. Policy for Acceptable Use",
        "You commit to using Plantellect legally and responsibly as a user. " +
                "You are welcome to register, use care tutorials, and add your own plant notes. " +
                "It is strictly forbidden to try to hack, reverse-engineer, scrape data, " +
                "overload or interfere with our systems, introduce malicious code, or " +
                "harvest information of other users."),
    TermsSection("5. Data Privacy and Sensitive Information Disclosure",
        "Plantellect is dedicated to upholding your fundamental right to privacy " +
                "in accordance with Republic Act No. 10173 (Data Privacy Act of 2012 of the Philippines). " +
                "You explicitly give us permission to process these data inputs when you use Plantellect."),
    TermsSection("6. Rights to Intellectual Property",
        "We are the owners of all Plantellect-related intellectual property rights. " +
                "You provide Plantellect a limited license to store and display any personal " +
                "information, notes, or plant photographs you submit to your dashboard, " +
                "but you still maintain complete ownership of these materials."),
    TermsSection("7. Limitation of Liability and Warranty Disclaimer",
        "Please be aware that Plantellect's services are provided solely for " +
                "informative reasons \"as-is\". We cannot be held responsible for the survival, " +
                "decline, or loss of any plants maintained with our application."),
    TermsSection("8. Termination of Account",
        "You can close your account at any moment. We also retain the right to suspend, " +
                "disable, or delete your account for security breaches or violations of these terms."),
    TermsSection("9. Regulating Law",
        "These terms and conditions shall be governed, interpreted, and enforced in " +
                "conformity with Philippine law."),
    TermsSection("10. Modifications to Terms",
        "We have the right to change, amend, or replace these terms and conditions " +
                "at any moment."),
)
