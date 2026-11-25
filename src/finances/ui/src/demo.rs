//! Fictional demo data: invented subscription names, amounts and dates. No
//! real person's data ever goes in here (the repository is public).

use crate::data::{
    BalancePoint, Currency, FinancesData, Frequency, LocalizedText, Money, MonthSummary, Movement,
    MovementKind, MovementStatus, Subscription, SubscriptionStatus, UpcomingCharge,
};
use chrono::NaiveDate;

/// A fictional demo exchange rate, only used to total mixed currencies.
const USD_TO_EUR: f64 = 0.92;

fn date(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).expect("demo date")
}

fn loc(en: &'static str, es: &'static str) -> LocalizedText {
    LocalizedText { en, es }
}

fn sub(
    id: &str,
    name: &str,
    description: LocalizedText,
    price: Option<Money>,
    frequency: Frequency,
    status: SubscriptionStatus,
    next_charge: Option<NaiveDate>,
) -> Subscription {
    Subscription {
        id: id.to_string(),
        name: name.to_string(),
        description,
        price,
        frequency,
        status,
        next_charge,
        end_date: None,
    }
}

fn movement(
    id: &str,
    kind: MovementKind,
    name: &str,
    category: Option<LocalizedText>,
    amount: Money,
    date: NaiveDate,
    status: MovementStatus,
) -> Movement {
    Movement {
        id: id.to_string(),
        kind,
        name: name.to_string(),
        subscription_id: None,
        category,
        amount,
        date,
        time: None,
        frequency: Frequency::Once,
        end_date: None,
        status,
        paused: false,
        notes: None,
    }
}

/// A monthly movement, optionally paused.
fn recurring(base: Movement, paused: bool) -> Movement {
    Movement {
        frequency: Frequency::Monthly,
        paused,
        ..base
    }
}

fn charge(id: &str, subscription_id: &str, name: &str, amount: Money, date: NaiveDate) -> Movement {
    Movement {
        kind: MovementKind::Charge,
        subscription_id: Some(subscription_id.to_string()),
        status: if amount.minor == 0 {
            MovementStatus::NotCharged
        } else {
            MovementStatus::Done
        },
        ..movement(
            id,
            MovementKind::Charge,
            name,
            None,
            amount,
            date,
            MovementStatus::Done,
        )
    }
}

/// The demo's fixed "today", so renders are reproducible.
pub const DEMO_TODAY: (i32, u32, u32) = (2026, 11, 25);

pub struct DemoData {
    today: NaiveDate,
    balance: Money,
    balance_date: NaiveDate,
    forecast: Money,
    month: MonthSummary,
    upcoming: Vec<UpcomingCharge>,
    subscriptions: Vec<Subscription>,
    history: Vec<BalancePoint>,
    movements: Vec<Movement>,
}

impl DemoData {
    pub fn new() -> Self {
        let today = date(DEMO_TODAY.0, DEMO_TODAY.1, DEMO_TODAY.2);
        let mut subscriptions = vec![
            sub(
                "almacen-nube",
                "AlmacenNube",
                LocalizedText {
                    en: "Cloud files and backups",
                    es: "Archivos y copias en la nube",
                },
                Some(Money::eur(999)),
                Frequency::Monthly,
                SubscriptionStatus::Active,
                Some(date(2026, 11, 28)),
            ),
            sub(
                "cine-en-pantallas",
                "CineEnPantallas",
                LocalizedText {
                    en: "Movies and series on demand",
                    es: "Películas y series bajo demanda",
                },
                Some(Money::eur(1299)),
                Frequency::Monthly,
                SubscriptionStatus::Active,
                Some(date(2026, 12, 1)),
            ),
            sub(
                "entrena-plus",
                "EntrenaPlus",
                LocalizedText {
                    en: "Workout plans and classes",
                    es: "Planes y clases de ejercicio",
                },
                Some(Money::eur(1500)),
                Frequency::Monthly,
                SubscriptionStatus::Active,
                Some(date(2026, 11, 30)),
            ),
            sub(
                "llamadas-pro",
                "LlamadasPro",
                LocalizedText {
                    en: "Video calls, billed in USD",
                    es: "Videollamadas, cobradas en USD",
                },
                Some(Money::usd(600)),
                Frequency::Monthly,
                SubscriptionStatus::Active,
                Some(date(2026, 12, 8)),
            ),
            sub(
                "hosting-ejemplo",
                "Hosting ejemplo.dev",
                LocalizedText {
                    en: "Hosting for a sample website",
                    es: "Alojamiento de un sitio de ejemplo",
                },
                Some(Money::usd(129)),
                Frequency::Annual,
                SubscriptionStatus::Active,
                Some(date(2027, 3, 21)),
            ),
            sub(
                "musica-manana",
                "MusicaMañana",
                LocalizedText {
                    en: "Music streaming",
                    es: "Música en streaming",
                },
                Some(Money::eur(999)),
                Frequency::Monthly,
                SubscriptionStatus::Paused,
                None,
            ),
            sub(
                "deporte-total",
                "DeporteTotal",
                LocalizedText {
                    en: "Sports channels",
                    es: "Canales de deporte",
                },
                Some(Money::eur(750)),
                Frequency::Monthly,
                SubscriptionStatus::Cancelled,
                None,
            ),
            sub(
                "lector-ilimitado",
                "LectorIlimitado",
                LocalizedText {
                    en: "Digital library",
                    es: "Biblioteca digital",
                },
                Some(Money::eur(499)),
                Frequency::Monthly,
                SubscriptionStatus::Finished,
                None,
            ),
            sub(
                "movilidad-urbana",
                "MovilidadUrbana",
                LocalizedText {
                    en: "City transport passes",
                    es: "Desplazamientos por la ciudad",
                },
                None,
                Frequency::Monthly,
                SubscriptionStatus::Active,
                Some(date(2026, 12, 5)),
            ),
        ];
        // A six-month promo that ends in June 2027.
        if let Some(promo) = subscriptions
            .iter_mut()
            .find(|s| s.id == "cine-en-pantallas")
        {
            promo.end_date = Some(date(2027, 6, 1));
        }
        let upcoming = vec![
            UpcomingCharge {
                subscription_id: "almacen-nube".into(),
                name: "AlmacenNube".into(),
                amount: Some(Money::eur(999)),
                date: date(2026, 11, 28),
            },
            UpcomingCharge {
                subscription_id: "entrena-plus".into(),
                name: "EntrenaPlus".into(),
                amount: Some(Money::eur(1500)),
                date: date(2026, 11, 30),
            },
            UpcomingCharge {
                subscription_id: "cine-en-pantallas".into(),
                name: "CineEnPantallas".into(),
                amount: Some(Money::eur(1299)),
                date: date(2026, 12, 1),
            },
            UpcomingCharge {
                subscription_id: "movilidad-urbana".into(),
                name: "MovilidadUrbana".into(),
                amount: None,
                date: date(2026, 12, 5),
            },
            UpcomingCharge {
                subscription_id: "llamadas-pro".into(),
                name: "LlamadasPro".into(),
                amount: Some(Money::usd(600)),
                date: date(2026, 12, 8),
            },
        ];
        let history = [
            (2026, 9, 3, 510210),
            (2026, 9, 10, 498840),
            (2026, 9, 17, 504175),
            (2026, 9, 24, 489020),
            (2026, 10, 1, 475560),
            (2026, 10, 8, 480215),
            (2026, 10, 15, 461030),
            (2026, 10, 22, 468890),
            (2026, 10, 29, 452105),
            (2026, 11, 5, 457740),
            (2026, 11, 12, 440280),
            (2026, 11, 19, 435025),
            (2026, 11, 25, 421357),
        ]
        .into_iter()
        .map(|(y, m, d, minor)| BalancePoint {
            date: date(y, m, d),
            balance: Money::eur(minor),
        })
        .collect();
        let balance = Money::eur(421357);
        // Fictional movements over the last months: recurring salary and rent,
        // one-off expenses, and the real charges the bank recorded for past
        // subscription cycles.
        let movements = vec![
            recurring(
                movement(
                    "ing-nomina",
                    MovementKind::Income,
                    "Nómina Estudio Norte",
                    Some(loc("Salary", "Nómina")),
                    Money::eur(235000),
                    date(2026, 6, 1),
                    MovementStatus::Received,
                ),
                false,
            ),
            recurring(
                movement(
                    "ing-beca",
                    MovementKind::Income,
                    "Beca colaboración",
                    Some(loc("Grants", "Ayudas")),
                    Money::eur(20000),
                    date(2026, 6, 1),
                    MovementStatus::Expected,
                ),
                true,
            ),
            movement(
                "ing-freelance",
                MovementKind::Income,
                "Proyecto freelance",
                Some(loc("Freelance", "Autónomo")),
                Money::eur(48000),
                date(2026, 11, 12),
                MovementStatus::Received,
            ),
            movement(
                "ing-reembolso",
                MovementKind::Income,
                "Reembolso seguro",
                Some(loc("Refunds", "Devoluciones")),
                Money::eur(15000),
                date(2026, 9, 3),
                MovementStatus::Received,
            ),
            recurring(
                movement(
                    "gas-alquiler",
                    MovementKind::Expense,
                    "Alquiler",
                    Some(loc("Home", "Hogar")),
                    Money::eur(85000),
                    date(2026, 6, 1),
                    MovementStatus::Done,
                ),
                false,
            ),
            recurring(
                movement(
                    "gas-transporte",
                    MovementKind::Expense,
                    "Transporte público",
                    Some(loc("Transport", "Transporte")),
                    Money::eur(4000),
                    date(2026, 6, 5),
                    MovementStatus::Done,
                ),
                false,
            ),
            movement(
                "gas-super-1",
                MovementKind::Expense,
                "Supermercado",
                Some(loc("Groceries", "Compras")),
                Money::eur(6240),
                date(2026, 11, 24),
                MovementStatus::Done,
            ),
            movement(
                "gas-super-2",
                MovementKind::Expense,
                "Supermercado",
                Some(loc("Groceries", "Compras")),
                Money::eur(5810),
                date(2026, 11, 18),
                MovementStatus::Done,
            ),
            movement(
                "gas-super-3",
                MovementKind::Expense,
                "Supermercado",
                Some(loc("Groceries", "Compras")),
                Money::eur(7125),
                date(2026, 11, 11),
                MovementStatus::Done,
            ),
            movement(
                "gas-restaurante",
                MovementKind::Expense,
                "Cena con amigos",
                Some(loc("Leisure", "Ocio")),
                Money::eur(3450),
                date(2026, 11, 21),
                MovementStatus::Done,
            ),
            movement(
                "gas-farmacia",
                MovementKind::Expense,
                "Farmacia",
                Some(loc("Health", "Salud")),
                Money::eur(1230),
                date(2026, 11, 8),
                MovementStatus::Pending,
            ),
            movement(
                "gas-libros",
                MovementKind::Expense,
                "Libros técnicos",
                Some(loc("Education", "Educación")),
                Money::usd(2599),
                date(2026, 10, 2),
                MovementStatus::Done,
            ),
            movement(
                "gas-curso",
                MovementKind::Expense,
                "Curso online",
                Some(loc("Education", "Educación")),
                Money::eur(4900),
                date(2026, 9, 15),
                MovementStatus::Done,
            ),
            movement(
                "gas-regalo",
                MovementKind::Expense,
                "Regalo aniversario",
                Some(loc("Gifts", "Regalos")),
                Money::eur(2750),
                date(2026, 8, 20),
                MovementStatus::Done,
            ),
            // Real charges of past subscription cycles.
            charge(
                "cobro-almacen-1",
                "almacen-nube",
                "AlmacenNube",
                Money::eur(999),
                date(2026, 9, 28),
            ),
            charge(
                "cobro-almacen-2",
                "almacen-nube",
                "AlmacenNube",
                Money::eur(999),
                date(2026, 10, 28),
            ),
            charge(
                "cobro-entrena",
                "entrena-plus",
                "EntrenaPlus",
                Money::eur(1500),
                date(2026, 10, 30),
            ),
            charge(
                "cobro-cine",
                "cine-en-pantallas",
                "CineEnPantallas",
                Money::eur(1299),
                date(2026, 11, 1),
            ),
            charge(
                "cobro-llamadas",
                "llamadas-pro",
                "LlamadasPro",
                Money::usd(600),
                date(2026, 10, 8),
            ),
            charge(
                "cobro-hosting",
                "hosting-ejemplo",
                "Hosting ejemplo.dev",
                Money::usd(129),
                date(2026, 3, 21),
            ),
        ];
        let recurring = recurring_monthly(&subscriptions);
        let forecast = Money::eur(
            balance.minor
                - upcoming
                    .iter()
                    .filter_map(|charge| charge.amount)
                    .map(to_eur)
                    .sum::<i64>(),
        );
        let month = MonthSummary {
            year: 2026,
            month: 11,
            spent: Money::eur(81240),
            recurring,
            upcoming: upcoming.len(),
        };
        DemoData {
            today,
            balance,
            balance_date: today,
            forecast,
            month,
            upcoming,
            subscriptions,
            history,
            movements,
        }
    }
}

fn to_eur(amount: Money) -> i64 {
    match amount.currency {
        crate::data::Currency::Eur => amount.minor,
        crate::data::Currency::Usd => (amount.minor as f64 * USD_TO_EUR).round() as i64,
    }
}

/// The monthly-equivalent cost of the active subscriptions, in EUR.
fn recurring_monthly(subscriptions: &[Subscription]) -> Money {
    let mut total = 0i64;
    for sub in subscriptions {
        if sub.status != SubscriptionStatus::Active {
            continue;
        }
        let Some(price) = sub.price else {
            continue;
        };
        let eur = to_eur(price);
        total += match sub.frequency {
            Frequency::Once | Frequency::Weekly => 0,
            Frequency::Monthly => eur,
            Frequency::Quarterly => eur / 3,
            Frequency::Annual => eur / 12,
        };
    }
    Money::eur(total)
}

impl Default for DemoData {
    fn default() -> Self {
        Self::new()
    }
}

impl FinancesData for DemoData {
    fn today(&self) -> NaiveDate {
        self.today
    }

    fn balance(&self) -> Money {
        self.balance
    }

    fn balance_date(&self) -> NaiveDate {
        self.balance_date
    }

    fn month_end_forecast(&self) -> Money {
        self.forecast
    }

    fn month_summary(&self) -> MonthSummary {
        self.month.clone()
    }

    fn upcoming_charges(&self) -> &[UpcomingCharge] {
        &self.upcoming
    }

    fn subscriptions(&self) -> &[Subscription] {
        &self.subscriptions
    }

    fn balance_history(&self) -> &[BalancePoint] {
        &self.history
    }

    fn exchange_rate(&self, from: Currency, to: Currency) -> f64 {
        match (from, to) {
            (Currency::Usd, Currency::Eur) => USD_TO_EUR,
            (Currency::Eur, Currency::Usd) => 1.0 / USD_TO_EUR,
            _ => 1.0,
        }
    }

    fn movements(&self) -> &[Movement] {
        &self.movements
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Currency;

    #[test]
    fn demo_data_is_coherent() {
        let data = DemoData::new();
        let subs = data.subscriptions();
        assert!(subs.len() >= 8);
        // Upcoming charges are soonest first and reference known subscriptions.
        let upcoming = data.upcoming_charges();
        assert!(upcoming.windows(2).all(|w| w[0].date <= w[1].date));
        for charge in upcoming {
            assert!(subs.iter().any(|s| s.id == charge.subscription_id));
            assert!(charge.date >= data.today());
        }
        // The chart ends at the current balance.
        let history = data.balance_history();
        assert!(history.len() >= 2);
        assert_eq!(history.last().unwrap().balance, data.balance());
        assert!(history.windows(2).all(|w| w[0].date < w[1].date));
        // The month summary counts the upcoming charges.
        assert_eq!(data.month_summary().upcoming, upcoming.len());
        // The forecast subtracts the priced upcoming charges from the balance.
        let priced: i64 = upcoming
            .iter()
            .filter_map(|c| c.amount)
            .map(|a| match a.currency {
                Currency::Eur => a.minor,
                Currency::Usd => (a.minor as f64 * USD_TO_EUR).round() as i64,
            })
            .sum();
        assert_eq!(
            data.month_end_forecast().minor,
            data.balance().minor - priced
        );
        // One active subscription has no price: the incomplete-forecast state exists.
        assert!(
            subs.iter()
                .any(|s| s.status == SubscriptionStatus::Active && s.price.is_none())
        );
        // Recurring cost is positive and in EUR.
        assert!(data.month_summary().recurring.minor > 0);
        assert_eq!(data.month_summary().recurring.currency, Currency::Eur);
        // Movements are coherent: charges reference known subscriptions and
        // happened in the past; recurring movements have a monthly frequency.
        let movements = data.movements();
        assert!(movements.len() >= 10);
        for movement in movements {
            if movement.kind == crate::data::MovementKind::Charge {
                let id = movement
                    .subscription_id
                    .as_deref()
                    .expect("charge subscription");
                assert!(subs.iter().any(|s| s.id == id));
                assert!(movement.date <= data.today());
            }
        }
        assert!(movements.iter().any(|m| m.paused));
        assert!(movements.iter().any(|m| m.amount.currency == Currency::Usd));
        // The demo rate converts both ways.
        assert_eq!(data.exchange_rate(Currency::Eur, Currency::Eur), 1.0);
        assert_eq!(data.exchange_rate(Currency::Usd, Currency::Eur), 0.92);
        assert!((data.exchange_rate(Currency::Eur, Currency::Usd) - 1.0 / 0.92).abs() < 1e-9);
    }

    #[test]
    fn demo_names_are_the_invented_ones() {
        // A guard against accidentally copying real services into the demo.
        let data = DemoData::new();
        let names: Vec<&str> = data
            .subscriptions()
            .iter()
            .map(|s| s.name.as_str())
            .collect();
        for expected in [
            "AlmacenNube",
            "CineEnPantallas",
            "EntrenaPlus",
            "LlamadasPro",
            "MusicaMañana",
        ] {
            assert!(names.contains(&expected), "missing demo name {expected}");
        }
    }
}
