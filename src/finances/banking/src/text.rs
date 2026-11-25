//! The crate's words, in the two interface languages.
//!
//! Every failure this crate reports reaches the user, and the interface is
//! bilingual (English and Spanish from the start). [`Localized`] gives each
//! error its sentence in either language, and `Display` gives the English one
//! so a log line, a `panic!` message and an `?` conversion stay readable
//! without carrying a language through every call.
//!
//! Nothing here ever interpolates a token, a session id, an IBAN or a balance:
//! the details that are interpolated come from the API's own `message`
//! (bounded by [`crate::redact::clip`]) or from a `serde` error about a shape.

/// An interface language. `es` is Spain's Spanish (`tú` forms), the same
/// choice the app makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    English,
    Spanish,
}

impl Language {
    /// The setting code the app stores (`en` / `es-ES`).
    pub fn code(self) -> &'static str {
        match self {
            Language::English => "en",
            Language::Spanish => "es-ES",
        }
    }

    /// The language of a setting code; anything unrecognized is English, the
    /// same rule the app's interface language uses.
    pub fn from_code(code: &str) -> Self {
        match code {
            "es" | "es-ES" | "es_ES" => Language::Spanish,
            _ => Language::English,
        }
    }

    /// Pick one of two strings, as an owned sentence (every caller builds a
    /// message out of it).
    pub fn pick(self, english: &str, spanish: &str) -> String {
        match self {
            Language::English => english,
            Language::Spanish => spanish,
        }
        .to_string()
    }
}

/// Something the user will read, said in either language.
pub trait Localized {
    /// The sentence for `language`.
    fn localized(&self, language: Language) -> String;

    /// The English sentence, which is what `Display` shows.
    fn english(&self) -> String {
        self.localized(Language::English)
    }
}

/// Which id a context-free message is about, with its name in both languages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Context {
    /// A bank session.
    Session,
    /// A bank account.
    Account,
}

impl Context {
    /// The English name, as it appears inside a sentence.
    pub fn english(self) -> &'static str {
        match self {
            Context::Session => "the session",
            Context::Account => "the account",
        }
    }

    /// The Spanish name, as it appears inside a sentence.
    pub fn spanish(self) -> &'static str {
        match self {
            Context::Session => "la sesión",
            Context::Account => "la cuenta",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_codes_match_the_apps() {
        assert_eq!(Language::English.code(), "en");
        assert_eq!(Language::Spanish.code(), "es-ES");
        assert_eq!(Language::from_code("es"), Language::Spanish);
        assert_eq!(Language::from_code("es-ES"), Language::Spanish);
        assert_eq!(Language::from_code("en"), Language::English);
        assert_eq!(Language::from_code("fr"), Language::English);
        assert_eq!(
            Language::Spanish.pick("hello", "hola"),
            "hola",
            "spanish picks the second"
        );
    }

    #[test]
    fn the_default_impl_is_the_english_sentence() {
        struct Pair;
        impl Localized for Pair {
            fn localized(&self, language: Language) -> String {
                language.pick("english", "español")
            }
        }
        assert_eq!(Pair.english(), "english");
        assert_eq!(Pair.localized(Language::Spanish), "español");
    }

    #[test]
    fn contexts_are_named_in_both_languages() {
        assert_eq!(Context::Session.english(), "the session");
        assert_eq!(Context::Session.spanish(), "la sesión");
        assert_eq!(Context::Account.spanish(), "la cuenta");
    }
}
