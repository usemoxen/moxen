use crate::model::{INTERACTION_MODES, Selection, ThreadId};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Destination {
    Thread(ThreadId),
    Project(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Improvement {
    pub destination: Destination,
    pub revision: u64,
    pub directory: String,
    pub selection: Option<Selection>,
    pub original: String,
}

impl Improvement {
    pub fn still_matches(
        &self,
        destination: Option<&Destination>,
        selection: Option<&Selection>,
        directory: Option<&str>,
        revision: u64,
    ) -> bool {
        destination == Some(&self.destination)
            && selection == self.selection.as_ref()
            && directory == Some(self.directory.as_str())
            && revision == self.revision
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub invocation: String,
    pub description: String,
}

#[derive(Default, Debug)]
pub struct Inventory(pub Vec<Choice>);

impl Inventory {
    pub fn decode(value: &Value) -> Result<Self, String> {
        let trigger = match value["trigger"].as_str() {
            Some(trigger @ ("/" | "$")) => trigger,
            _ => return Err("The server did not return a skill inventory.".into()),
        };
        let mut choices: Vec<Choice> = vec![];
        for (kind, prefix) in [("skills", trigger), ("commands", "/")] {
            for item in value[kind].as_array().into_iter().flatten() {
                if kind == "skills" && (item["enabled"] != true || item["userInvocable"] != true) {
                    continue;
                }
                let Some(name) = item["name"]
                    .as_str()
                    .filter(|name| !name.is_empty() && !name.contains(char::is_whitespace))
                else {
                    continue;
                };
                let invocation = format!("{prefix}{name}");
                if !choices.iter().any(|choice| choice.invocation == invocation) {
                    choices.push(Choice {
                        invocation,
                        description: item["shortDescription"]
                            .as_str()
                            .or(item["description"].as_str())
                            .unwrap_or("")
                            .into(),
                    });
                }
            }
        }
        Ok(Self(choices))
    }
}

pub fn slash_prefix(text: &str, cursor: usize) -> Option<(usize, &str)> {
    let before = text.get(..cursor)?;
    let start = before
        .rfind(char::is_whitespace)
        .map_or(0, |at| at + before[at..].chars().next().unwrap().len_utf8());
    let word = &before[start..];
    let (prefix, name) = word.split_at_checked(1)?;
    if !matches!(prefix, "/" | "$")
        || (prefix == "/" && !before[..start].trim().is_empty())
        || !name
            .chars()
            .all(|ch| ch.is_alphanumeric() || "-_.:".contains(ch))
        || text[cursor..]
            .chars()
            .next()
            .is_some_and(|ch| !ch.is_whitespace())
    {
        return None;
    }
    Some((start, word))
}

pub fn choices(prefix: &str, inventory: Option<&Inventory>, busy: bool) -> Vec<Choice> {
    let built_in = INTERACTION_MODES
        .iter()
        .skip(1)
        .filter(|_| !busy)
        .map(|(mode, label)| Choice {
            invocation: format!("/{mode}"),
            description: format!("Use {label} for one prompt"),
        });
    let mut choices: Vec<Choice> = built_in.collect();
    if let Some(inventory) = inventory {
        for choice in &inventory.0 {
            if !choices
                .iter()
                .any(|other| other.invocation == choice.invocation)
            {
                choices.push(choice.clone());
            }
        }
    }
    let prefix = prefix.to_lowercase();
    choices.retain(|choice| {
        choice.invocation.to_lowercase().starts_with(&prefix)
            || (prefix == "/" && choice.invocation.starts_with('$'))
    });
    choices
}

pub fn mode_command(text: &str) -> Option<(&'static str, &str)> {
    let typed = text.trim().strip_prefix('/')?;
    let (name, rest) = typed.split_once(char::is_whitespace).unwrap_or((typed, ""));
    let mode = INTERACTION_MODES
        .iter()
        .skip(1)
        .find(|(mode, _)| *mode == name)?
        .0;
    Some((mode, rest.trim()))
}

#[cfg(test)]
mod tests {
    use super::{Destination, Improvement, Inventory, choices, mode_command, slash_prefix};
    use serde_json::json;

    #[test]
    fn recognizes_one_off_modes_without_treating_paths_or_other_commands_as_modes() {
        assert_eq!(
            mode_command(" /review\nChanges "),
            Some(("review", "Changes"))
        );
        assert_eq!(mode_command("/research"), Some(("research", "")));
        assert_eq!(
            mode_command("/orchestrate add checks"),
            Some(("orchestrate", "add checks"))
        );
        for input in [
            "/reviewer",
            "/review/notes",
            "use /review",
            "/compact",
            "/default",
        ] {
            assert_eq!(mode_command(input), None);
        }
        for (text, prefix) in [
            ("  /re", Some((2, "/re"))),
            ("//", None),
            ("word /re", None),
            ("前 $ski", Some((4, "$ski"))),
            ("/re/path", None),
        ] {
            assert_eq!(slash_prefix(text, text.len()), prefix);
        }
    }

    #[test]
    fn only_offers_enabled_user_invocable_skills_and_preserves_provider_trigger() {
        let inventory = Inventory::decode(&json!({
            "trigger":"$",
            "skills":[
              {"name":"check","enabled":true,"userInvocable":true},
              {"name":"internal","enabled":true,"userInvocable":false},
              {"name":"disabled","enabled":false,"userInvocable":true}
            ],
            "commands":[{"name":"compact"},{"name":"review","description":"Provider command"}]
        }))
        .unwrap();
        let names = |prefix, busy| {
            choices(prefix, Some(&inventory), busy)
                .into_iter()
                .map(|choice| choice.invocation)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names("/", false),
            ["/research", "/orchestrate", "/review", "$check", "/compact"]
        );
        assert_eq!(names("$c", false), ["$check"]);
        assert_eq!(names("/o", true), Vec::<String>::new());
        assert!(Inventory::decode(&json!({"trigger":"?"})).is_err());
    }

    #[test]
    fn an_improved_draft_cannot_replace_new_typing_or_a_different_destination() {
        let request = Improvement {
            destination: Destination::Thread(1),
            revision: 7,
            directory: "workspace".into(),
            selection: None,
            original: "my draft".into(),
        };
        assert!(request.still_matches(Some(&Destination::Thread(1)), None, Some("workspace"), 7));
        assert!(!request.still_matches(Some(&Destination::Thread(1)), None, Some("workspace"), 8));
        assert!(!request.still_matches(Some(&Destination::Thread(2)), None, Some("workspace"), 7));
        assert!(!request.still_matches(
            Some(&Destination::Thread(1)),
            None,
            Some("new workspace"),
            7
        ));
    }
}
