//! Fictional demo data: invented subscription names, amounts and dates. No
//! real person's data ever goes in here (the repository is public).

use crate::data::{
    BalancePoint, FinancesData, Frequency, LocalizedText, Money, MonthSummary, Subscription,
    SubscriptionStatus, UpcomingCharge,
};
use chrono::NaiveDate;

/// A fictional demo exchange rate, only used to total the recurring cost.
const USD_TO_EUR: f64 = 0.92;

fn date(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).expect("demo date")
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
}

impl DemoData {
    pub fn new() -> Self {
        let today = date(DEMO_TODAY.0, DEMO_TODAY.1, DEMO_TODAY.2);
        let subscriptions = vec![
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
