// CRUDE INTENTIONS — ClaudeTrader_CL NinjaScript Strategy
// Polls trade_signals.csv every 2 seconds, places bracketed limit orders for
// READY signals less than 30 seconds old, manages TP1/TP2/breakeven, and
// writes outcomes to trade_outcome.csv for the Python bridge to upload.
//
// Tick size:        0.01
// Tick value:       $10 per tick per contract
// Big point value:  1000 (CL)
//
// Drop into NinjaTrader 8: Documents\NinjaTrader 8\bin\Custom\Strategies\
// Compile via NinjaScript Editor (F5).

#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Xml.Serialization;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.Gui.SuperDom;
using NinjaTrader.Gui.Tools;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.Core.FloatingPoint;
using NinjaTrader.NinjaScript.Indicators;
using NinjaTrader.NinjaScript.DrawingTools;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    public class ClaudeTrader_CL : Strategy
    {
        #region Constants
        private const string LOG_PREFIX            = "[CI]";
        private const double TICK_SIZE             = 0.01;
        private const double TICK_VALUE_PER_CONTRACT = 10.0;
        private const double BIG_POINT_VALUE       = 1000.0;
        private const int    POLL_INTERVAL_SECONDS = 2;
        private const int    SIGNAL_FRESHNESS_SECONDS = 30;
        #endregion

        #region Configurable paths
        [NinjaScriptProperty]
        [Display(Name = "Signals CSV", Order = 1, GroupName = "Crude Intentions")]
        public string SignalsCsvPath { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Outcomes CSV", Order = 2, GroupName = "Crude Intentions")]
        public string OutcomesCsvPath { get; set; }
        #endregion

        #region State
        private DateTime lastPollTime = DateTime.MinValue;
        private readonly HashSet<string> processedSignalIds = new HashSet<string>();

        // Per-active-trade state — only one signal active at a time on a single instrument.
        private string  activeSignalId      = null;
        private string  activeDirection     = null;
        private double  activeEntry         = 0.0;
        private double  activeStop          = 0.0;
        private double  activeTp1           = 0.0;
        private double  activeTp2           = 0.0;
        private int     activeContracts     = 0;
        private int     activeTp1Contracts  = 0;
        private int     activeTp2Contracts  = 0;
        private bool    tp1Hit              = false;
        private bool    movedToBreakeven    = false;
        private DateTime activeOpenedAt     = DateTime.MinValue;

        // Order references for OnOrderUpdate / OnExecutionUpdate.
        private Order entryOrder      = null;
        private Order stopOrder       = null;
        private Order tp1Order        = null;
        private Order tp2Order        = null;
        #endregion

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description                  = @"Crude Intentions CSV-driven CL trader. Polls trade_signals.csv and brackets entries.";
                Name                         = "ClaudeTrader_CL";
                Calculate                    = Calculate.OnEachTick;
                EntriesPerDirection          = 1;
                EntryHandling                = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy = true;
                ExitOnSessionCloseSeconds    = 30;
                IsFillLimitOnTouch           = false;
                MaximumBarsLookBack          = MaximumBarsLookBack.TwoHundredFiftySix;
                OrderFillResolution          = OrderFillResolution.Standard;
                Slippage                     = 0;
                StartBehavior                = StartBehavior.WaitUntilFlat;
                TimeInForce                  = TimeInForce.Gtc;
                TraceOrders                  = false;
                RealtimeErrorHandling        = RealtimeErrorHandling.StopCancelClose;
                StopTargetHandling           = StopTargetHandling.PerEntryExecution;
                BarsRequiredToTrade          = 1;
                IsInstantiatedOnEachOptimizationIteration = true;

                SignalsCsvPath  = @"C:\CrudeIntentions\data\trade_signals.csv";
                OutcomesCsvPath = @"C:\CrudeIntentions\data\trade_outcome.csv";
            }
            else if (State == State.Configure)
            {
                Print(string.Format("{0} ClaudeTrader_CL configured. Signals={1} Outcomes={2}",
                    LOG_PREFIX, SignalsCsvPath, OutcomesCsvPath));
            }
            else if (State == State.Realtime)
            {
                Print(LOG_PREFIX + " Strategy entered realtime mode.");
                EnsureOutcomesCsv();
            }
        }

        protected override void OnBarUpdate()
        {
            if (State != State.Realtime) return;

            // Poll the signals CSV at most once every POLL_INTERVAL_SECONDS.
            if ((DateTime.UtcNow - lastPollTime).TotalSeconds >= POLL_INTERVAL_SECONDS)
            {
                lastPollTime = DateTime.UtcNow;
                try { PollSignalsCsv(); }
                catch (Exception ex) { Print(string.Format("{0} Poll error: {1}", LOG_PREFIX, ex.Message)); }
            }

            // After TP1 hits, move the stop on the remaining contracts to breakeven.
            if (activeSignalId != null && tp1Hit && !movedToBreakeven)
            {
                MoveStopToBreakeven();
            }
        }

        #region Signal CSV polling
        private void PollSignalsCsv()
        {
            if (!File.Exists(SignalsCsvPath)) return;

            string[] lines;
            try
            {
                lines = File.ReadAllLines(SignalsCsvPath);
            }
            catch (IOException ex)
            {
                Print(string.Format("{0} CSV read locked — will retry. {1}", LOG_PREFIX, ex.Message));
                return;
            }

            if (lines.Length < 2) return;

            string[] headers = SplitCsvLine(lines[0]);
            int idxStatus     = Array.IndexOf(headers, "Status");
            int idxSignalId   = Array.IndexOf(headers, "Signal_ID");
            int idxDateTime   = Array.IndexOf(headers, "DateTime");
            int idxDirection  = Array.IndexOf(headers, "Direction");
            int idxEntry      = Array.IndexOf(headers, "Entry_Price");
            int idxStop       = Array.IndexOf(headers, "Stop_Loss");
            int idxTp1        = Array.IndexOf(headers, "TP1");
            int idxTp2        = Array.IndexOf(headers, "TP2");
            int idxContracts  = Array.IndexOf(headers, "Contracts");
            int idxScore      = Array.IndexOf(headers, "Score");
            int idxGrade      = Array.IndexOf(headers, "Grade");

            if (idxStatus < 0 || idxSignalId < 0 || idxEntry < 0 || idxStop < 0)
            {
                Print(LOG_PREFIX + " Signals CSV missing required columns.");
                return;
            }

            for (int i = 1; i < lines.Length; i++)
            {
                string line = lines[i];
                if (string.IsNullOrWhiteSpace(line)) continue;
                string[] cols = SplitCsvLine(line);
                if (cols.Length < headers.Length) continue;

                string status   = SafeGet(cols, idxStatus);
                string signalId = SafeGet(cols, idxSignalId);

                if (status != "READY") continue;
                if (string.IsNullOrEmpty(signalId)) continue;
                if (processedSignalIds.Contains(signalId)) continue;

                // Freshness check — DateTime is UTC "yyyy-MM-dd HH:mm:ss".
                DateTime signalUtc;
                if (!DateTime.TryParseExact(SafeGet(cols, idxDateTime),
                        "yyyy-MM-dd HH:mm:ss",
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                        out signalUtc))
                {
                    Print(string.Format("{0} {1}: bad DateTime — skipping.", LOG_PREFIX, signalId));
                    processedSignalIds.Add(signalId);
                    continue;
                }
                double ageSeconds = (DateTime.UtcNow - signalUtc).TotalSeconds;
                if (ageSeconds > SIGNAL_FRESHNESS_SECONDS)
                {
                    Print(string.Format("{0} {1}: stale by {2:F1}s — skipping.", LOG_PREFIX, signalId, ageSeconds));
                    processedSignalIds.Add(signalId);
                    continue;
                }

                // Only one position at a time.
                if (activeSignalId != null)
                {
                    Print(string.Format("{0} {1}: position already active ({2}) — skipping.",
                        LOG_PREFIX, signalId, activeSignalId));
                    continue;
                }

                string direction = SafeGet(cols, idxDirection);
                double entry, stop, tp1, tp2;
                int contracts, score;
                string grade = SafeGet(cols, idxGrade);

                if (!double.TryParse(SafeGet(cols, idxEntry), NumberStyles.Float, CultureInfo.InvariantCulture, out entry) ||
                    !double.TryParse(SafeGet(cols, idxStop),  NumberStyles.Float, CultureInfo.InvariantCulture, out stop)  ||
                    !double.TryParse(SafeGet(cols, idxTp1),   NumberStyles.Float, CultureInfo.InvariantCulture, out tp1)   ||
                    !double.TryParse(SafeGet(cols, idxTp2),   NumberStyles.Float, CultureInfo.InvariantCulture, out tp2)   ||
                    !int.TryParse   (SafeGet(cols, idxContracts), out contracts) ||
                    !int.TryParse   (SafeGet(cols, idxScore),     out score))
                {
                    Print(string.Format("{0} {1}: malformed numeric column — skipping.", LOG_PREFIX, signalId));
                    processedSignalIds.Add(signalId);
                    continue;
                }

                processedSignalIds.Add(signalId);
                Print(string.Format("{0} {1}: READY {2} {3}x @ {4} stop={5} tp1={6} tp2={7} score={8} grade={9}",
                    LOG_PREFIX, signalId, direction, contracts, entry, stop, tp1, tp2, score, grade));

                PlaceBracketedEntry(signalId, direction, entry, stop, tp1, tp2, contracts);
            }
        }
        #endregion

        #region Order placement
        private void PlaceBracketedEntry(string signalId, string direction, double entry,
                                        double stop, double tp1, double tp2, int contracts)
        {
            int half     = Math.Max(1, contracts / 2);
            int tp1Qty   = half;
            int tp2Qty   = Math.Max(0, contracts - half);

            activeSignalId     = signalId;
            activeDirection    = direction;
            activeEntry        = entry;
            activeStop         = stop;
            activeTp1          = tp1;
            activeTp2          = tp2;
            activeContracts    = contracts;
            activeTp1Contracts = tp1Qty;
            activeTp2Contracts = tp2Qty;
            tp1Hit             = false;
            movedToBreakeven   = false;
            activeOpenedAt     = DateTime.UtcNow;

            string entryName = "CI_ENTRY_" + signalId;
            string stopName  = "CI_STOP_"  + signalId;
            string tp1Name   = "CI_TP1_"   + signalId;
            string tp2Name   = "CI_TP2_"   + signalId;

            if (direction == "LONG")
            {
                entryOrder = EnterLongLimit(0, true, contracts, entry, entryName);
                if (tp2Qty > 0)
                {
                    SetStopLoss(entryName, CalculationMode.Price, stop, false);
                    SetProfitTarget(entryName, CalculationMode.Price, tp2);
                }
                else
                {
                    SetStopLoss(entryName, CalculationMode.Price, stop, false);
                    SetProfitTarget(entryName, CalculationMode.Price, tp1);
                }
                if (tp1Qty > 0 && tp2Qty > 0)
                {
                    tp1Order = ExitLongLimit(0, true, tp1Qty, tp1, tp1Name, entryName);
                }
            }
            else if (direction == "SHORT")
            {
                entryOrder = EnterShortLimit(0, true, contracts, entry, entryName);
                if (tp2Qty > 0)
                {
                    SetStopLoss(entryName, CalculationMode.Price, stop, false);
                    SetProfitTarget(entryName, CalculationMode.Price, tp2);
                }
                else
                {
                    SetStopLoss(entryName, CalculationMode.Price, stop, false);
                    SetProfitTarget(entryName, CalculationMode.Price, tp1);
                }
                if (tp1Qty > 0 && tp2Qty > 0)
                {
                    tp1Order = ExitShortLimit(0, true, tp1Qty, tp1, tp1Name, entryName);
                }
            }
            else
            {
                Print(string.Format("{0} {1}: unknown direction '{2}' — abort.", LOG_PREFIX, signalId, direction));
                ResetActive();
                return;
            }

            Print(string.Format("{0} {1}: bracketed entry placed. tp1Qty={2} tp2Qty={3}",
                LOG_PREFIX, signalId, tp1Qty, tp2Qty));
        }

        private void MoveStopToBreakeven()
        {
            if (activeSignalId == null) return;
            try
            {
                string entryName = "CI_ENTRY_" + activeSignalId;
                SetStopLoss(entryName, CalculationMode.Price, activeEntry, false);
                movedToBreakeven = true;
                Print(string.Format("{0} {1}: moved stop to breakeven @ {2}",
                    LOG_PREFIX, activeSignalId, activeEntry));
            }
            catch (Exception ex)
            {
                Print(string.Format("{0} {1}: breakeven move failed: {2}",
                    LOG_PREFIX, activeSignalId, ex.Message));
            }
        }
        #endregion

        #region Order / Execution updates
        protected override void OnOrderUpdate(Order order, double limitPrice, double stopPrice,
                                              int quantity, int filled, double averageFillPrice,
                                              OrderState orderState, DateTime time, ErrorCode error,
                                              string nativeError)
        {
            if (order == null || activeSignalId == null) return;
            if (order.Name == null) return;

            if (order.Name.StartsWith("CI_") && (orderState == OrderState.Cancelled || orderState == OrderState.Rejected))
            {
                Print(string.Format("{0} {1}: order {2} {3}. {4}",
                    LOG_PREFIX, activeSignalId, order.Name, orderState, nativeError ?? ""));
            }
        }

        protected override void OnExecutionUpdate(Execution execution, string executionId, double price,
                                                  int quantity, MarketPosition marketPosition,
                                                  string orderId, DateTime time)
        {
            if (execution == null || execution.Order == null || activeSignalId == null) return;
            string name = execution.Order.Name ?? "";

            // TP1 partial fill detection.
            if (name == "CI_TP1_" + activeSignalId && execution.Order.OrderState == OrderState.Filled)
            {
                tp1Hit = true;
                Print(string.Format("{0} {1}: TP1 hit @ {2} qty={3}",
                    LOG_PREFIX, activeSignalId, price, quantity));
            }

            // Position fully flat → write outcome.
            if (Position.MarketPosition == MarketPosition.Flat && activeSignalId != null)
            {
                CloseAndLogOutcome(price, time);
            }
        }
        #endregion

        #region Outcome write
        private void CloseAndLogOutcome(double closePrice, DateTime closeTime)
        {
            string signalId = activeSignalId;
            string direction = activeDirection;
            double entry     = activeEntry;
            double stop      = activeStop;
            double tp1       = activeTp1;
            double tp2       = activeTp2;
            int contracts    = activeContracts;
            bool didTp1      = tp1Hit;

            string reason;
            if (didTp1 && IsAtOrBeyond(direction, closePrice, tp2))
                reason = "TP2_HIT";
            else if (didTp1 && Math.Abs(closePrice - entry) <= TICK_SIZE * 2)
                reason = "BREAKEVEN";
            else if (didTp1)
                reason = "TP1_HIT";
            else if (IsAtOrBeyond(direction, closePrice, tp1))
                reason = "CLOSED_PROFIT";
            else if (IsAtOrBeyond(direction == "LONG" ? "SHORT" : "LONG", closePrice, stop))
                reason = "STOPPED_OUT";
            else
                reason = "SCRATCH";

            double signedTicks = direction == "LONG"
                ? (closePrice - entry) / TICK_SIZE
                : (entry - closePrice) / TICK_SIZE;
            double ticksPnl   = Math.Round(signedTicks, 1);
            double dollarsPnl = Math.Round(signedTicks * TICK_VALUE_PER_CONTRACT * contracts, 2);

            Print(string.Format("{0} {1}: closed @ {2} reason={3} ticks={4} dollars={5}",
                LOG_PREFIX, signalId, closePrice, reason, ticksPnl, dollarsPnl));

            try { AppendOutcomeRow(signalId, closeTime, closePrice, ticksPnl, dollarsPnl, reason); }
            catch (Exception ex) { Print(string.Format("{0} {1}: outcome write failed: {2}",
                LOG_PREFIX, signalId, ex.Message)); }

            ResetActive();
        }

        private void EnsureOutcomesCsv()
        {
            try
            {
                string dir = Path.GetDirectoryName(OutcomesCsvPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    Directory.CreateDirectory(dir);
                if (!File.Exists(OutcomesCsvPath))
                {
                    File.WriteAllText(OutcomesCsvPath,
                        "Signal_ID,Close_Time,Close_Price,Ticks_PnL,Dollars_PnL,Close_Reason" + Environment.NewLine);
                }
            }
            catch (Exception ex)
            {
                Print(string.Format("{0} EnsureOutcomesCsv failed: {1}", LOG_PREFIX, ex.Message));
            }
        }

        private void AppendOutcomeRow(string signalId, DateTime closeTime, double closePrice,
                                      double ticksPnl, double dollarsPnl, string reason)
        {
            EnsureOutcomesCsv();
            string row = string.Format(CultureInfo.InvariantCulture,
                "{0},{1:yyyy-MM-dd HH:mm:ss},{2},{3},{4},{5}{6}",
                signalId, closeTime.ToUniversalTime(), closePrice,
                ticksPnl, dollarsPnl, reason, Environment.NewLine);
            File.AppendAllText(OutcomesCsvPath, row);
        }
        #endregion

        #region Helpers
        private static bool IsAtOrBeyond(string direction, double price, double level)
        {
            if (direction == "LONG")  return price >= level - TICK_SIZE / 2.0;
            if (direction == "SHORT") return price <= level + TICK_SIZE / 2.0;
            return false;
        }

        private void ResetActive()
        {
            activeSignalId      = null;
            activeDirection     = null;
            activeEntry         = 0.0;
            activeStop          = 0.0;
            activeTp1           = 0.0;
            activeTp2           = 0.0;
            activeContracts     = 0;
            activeTp1Contracts  = 0;
            activeTp2Contracts  = 0;
            tp1Hit              = false;
            movedToBreakeven    = false;
            entryOrder          = null;
            stopOrder           = null;
            tp1Order            = null;
            tp2Order            = null;
            activeOpenedAt      = DateTime.MinValue;
        }

        private static string SafeGet(string[] cols, int idx)
        {
            if (idx < 0 || idx >= cols.Length) return "";
            return cols[idx] ?? "";
        }

        // Minimal CSV splitter — handles unquoted simple values used by the bridge.
        private static string[] SplitCsvLine(string line)
        {
            if (string.IsNullOrEmpty(line)) return new string[0];
            List<string> result = new List<string>();
            StringBuilder cur = new StringBuilder();
            bool inQuotes = false;
            for (int i = 0; i < line.Length; i++)
            {
                char c = line[i];
                if (c == '"') { inQuotes = !inQuotes; continue; }
                if (c == ',' && !inQuotes) { result.Add(cur.ToString()); cur.Clear(); continue; }
                cur.Append(c);
            }
            result.Add(cur.ToString());
            return result.ToArray();
        }
        #endregion
    }
}
