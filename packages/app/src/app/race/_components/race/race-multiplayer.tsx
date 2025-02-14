"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { saveUserResultAction } from "../../actions";
import { userRacePresenceEvent } from "@code-racer/wss/src/events/common";
import { io } from "socket.io-client";
import { Language } from "@/config/languages";
import {
  GameStateUpdatePayload,
  gameStateUpdateEvent,
  userRaceResponseEvent,
} from "@code-racer/wss/src/events/server-to-client";

// utils
import { calculateAccuracy, calculateCPM, noopKeys } from "./utils";

// Components
import MultiplayerLoadingLobby from "../multiplayer-loading-lobby";
import RaceTracker from "./race-tracker";
import Code from "./code";
import RaceDetails from "./race-details";
import { Heading } from "@/components/ui/heading";
import { Button } from "@/components/ui/button";
import { ReportButton } from "./buttons/report-button";
import RaceTimer from "./race-timer";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Types
import { RaceStatus } from "@code-racer/wss/src/types";
import { RaceTimeStampProps, ReplayTimeStampProps } from "./types";
import type { User } from "next-auth";
import type { Socket } from "socket.io-client";
import type { Snippet } from "@prisma/client";
import type { ClientToServerEvents } from "@code-racer/wss/src/events/client-to-server";
import type { RaceStatusType } from "@code-racer/wss/src/types";
import type { ServerToClientEvents } from "@code-racer/wss/src/events/server-to-client";

type Participant = Omit<
  GameStateUpdatePayload["raceState"]["participants"][number],
  "socketId"
>;

let socket: Socket<ServerToClientEvents, ClientToServerEvents>;

async function getSocketConnection() {
  if (socket) return;
  socket = io(process.env.NEXT_PUBLIC_WSS_URL!); // KEEP AS IS
  // console.log({ socket });
}

export default function RaceMultiplayer({
  user,
  practiceSnippet,
  language,
}: {
  user?: User;
  practiceSnippet?: Snippet;
  language: Language;
}) {
  const [input, setInput] = useState("");
  const [textIndicatorPosition, setTextIndicatorPosition] = useState(0);
  const [currentLineNumber, setCurrentLineNumber] = useState(0);
  const [currentCharPosition, setCurrentCharPosition] = useState(0);
  const [currentChar, setCurrentChar] = useState("");
  const [raceStatus, setRaceStatus] = useState<RaceStatusType>(
    //if the practiceSnippet is present, it means that the race is a practice race
    Boolean(practiceSnippet) ? RaceStatus.RUNNING : RaceStatus.WAITING,
  );
  const [snippet, setSnippet] = useState<Snippet | undefined>(practiceSnippet);
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [submittingResults, setSubmittingResults] = useState(false);
  const [totalErrors, setTotalErrors] = useState(0);

  const [raceTimeStamp, setRaceTimeStamp] = useState<RaceTimeStampProps[]>([]);
  const [replayTimeStamp, setReplayTimeStamp] = useState<
    ReplayTimeStampProps[]
  >([]);

  const code = snippet?.code.trimEnd();
  const currentText = code?.substring(0, input.length);
  const errors = input
    .split("")
    .map((char, index) => (char !== currentText?.[index] ? index : -1))
    .filter((index) => index !== -1);

  const inputElement = useRef<HTMLInputElement | null>(null);
  const router = useRouter();

  //multiplayer-specific -----------------------------------------------------------------------------------
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [raceStartCountdown, setRaceStartCountdown] = useState(0);
  const [raceId, setRaceId] = useState<string | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const position = code
    ? parseFloat(
        (((input.length - errors.length) / code.length) * 100).toFixed(2),
      )
    : null;
  const isRaceFinished = practiceSnippet
    ? input === code
    : raceStatus === RaceStatus.FINISHED;
  const showRaceTimer = !!startTime && !isRaceFinished;

  function startRaceEventHandlers() {
    socket.on("UserRaceResponse", (payload) => {
      const { snippet, raceParticipantId, raceId } =
        userRaceResponseEvent.parse(payload);
      setSnippet(snippet);
      setRaceId(raceId);
      setParticipantId(raceParticipantId);

      socket.emit("UserRaceEnter", {
        raceParticipantId: raceParticipantId,
        raceId,
        socketId: socket.id,
      });
    });

    socket.on("GameStateUpdate", (payload) => {
      const { raceState } = gameStateUpdateEvent.parse(payload);
      setParticipants(raceState.participants);
      setRaceStatus(raceState.status);

      if (raceState.countdown) {
        setRaceStartCountdown(raceState.countdown);
      } else if (raceState.countdown === 0) {
        setStartTime(new Date());
      }
    });

    socket.on("UserEnterFullRace", () => {
      router.refresh();
    });

    socket.on("UserRaceEnter", (payload) => {
      const { raceParticipantId: participantId } =
        userRacePresenceEvent.parse(payload);
      setParticipants((participants) => [
        ...participants,
        { id: participantId, position: 0, finishedAt: null },
      ]);
    });

    socket.on("UserRaceLeave", (payload) => {
      const { raceParticipantId: participantId } =
        userRacePresenceEvent.parse(payload);
      setParticipants((participants) =>
        participants.filter((participant) => participant.id !== participantId),
      );
    });
  }

  // Connection to wss
  useEffect(() => {
    if (practiceSnippet) return;
    getSocketConnection().then(() => {
      socket.on("connect", () => {
        startRaceEventHandlers();
        socket.emit("UserRaceRequest", {
          language,
          userId: user?.id,
        });
      });
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  //send updated position to server
  useEffect(() => {
    if (
      !participantId ||
      !raceId ||
      raceStatus !== RaceStatus.RUNNING ||
      !position
    )
      return;

    const gameLoop = setInterval(() => {
      if (raceStatus === RaceStatus.RUNNING) {
        socket.emit("PositionUpdate", {
          socketId: socket.id,
          raceParticipantId: participantId,
          position,
          raceId,
        });
      }
    }, 200);
    return () => clearInterval(gameLoop);
  }, [raceStatus, position, participantId, raceId]);
  //end of multiplayer-specific -----------------------------------------------------------------------------------

  async function endRace() {
    if (!startTime) return;
    const endTime = new Date();
    const timeTaken = (endTime.getTime() - startTime.getTime()) / 1000;

    localStorage.setItem(
      "raceTimeStamp",
      JSON.stringify([
        ...raceTimeStamp,
        {
          char: currentChar,
          accuracy: calculateAccuracy(input.length, totalErrors),
          cpm: calculateCPM(input.length, timeTaken),
          time: Date.now(),
        },
      ]),
    );

    localStorage.setItem(
      "replayTimeStamp",
      JSON.stringify([
        ...replayTimeStamp,
        {
          char: currentChar,
          textIndicatorPosition,
          currentLineNumber,
          currentCharPosition,
          errors,
          totalErrors,
          time: Date.now(),
        },
      ]),
    );

    if (!snippet || !code) {
      setSubmittingResults(false);
      return;
    }

    if (user) {
      const result = await saveUserResultAction({
        timeTaken,
        errors: totalErrors,
        cpm: calculateCPM(code.length - 1, timeTaken),
        accuracy: calculateAccuracy(code.length - 1, totalErrors),
        snippetId: snippet.id,
      });

      if (!result) {
        return router.refresh();
      }

      router.push(`/result?resultId=${result.id}`);
    } else {
      router.push(`/result?snippetId=${snippet.id}`);
    }

    setSubmittingResults(false);
  }

  useEffect(() => {
    if (isRaceFinished) {
      endRace();
    }
  }, [isRaceFinished]);

  useEffect(() => {
    // Focus Input
    inputElement.current?.focus();

    // Calculate the current line and cursor position in that line
    const lines = input.split("\n");
    setCurrentLineNumber(lines.length);
    setCurrentCharPosition(lines[lines.length - 1].length);
    setReplayTimeStamp((prev) => [
      ...prev,
      {
        char: currentChar,
        textIndicatorPosition,
        currentLineNumber,
        currentCharPosition,
        errors,
        totalErrors,
        time: Date.now(),
      },
    ]);
  }, [input]);

  function handleKeyboardDownEvent(e: React.KeyboardEvent<HTMLInputElement>) {
    // Restart
    if (e.key === "Escape") {
      handleRestart();
      return;
    }
    // Unfocus Shift + Tab
    if (e.shiftKey && e.key === "Tab") {
      e.currentTarget.blur();
      return;
    }
    // Reload Control + r
    if (e.ctrlKey && e.key === "r") {
      e.preventDefault;
      return;
    }
    // Catch Alt Gr - Please confirm I am unable to test this
    if (e.ctrlKey && e.altKey) {
      e.preventDefault();
    }

    if (noopKeys.includes(e.key)) {
      e.preventDefault();
    } else {
      switch (e.key) {
        case "Backspace":
          Backspace();
          break;
        case "Enter":
          if (input !== code?.slice(0, input.length)) {
            return;
          }
          Enter();
          if (!startTime) {
            setStartTime(new Date());
          }
          break;
        default:
          if (input !== code?.slice(0, input.length)) {
            return;
          }
          Key(e);
          if (!startTime) {
            setStartTime(new Date());
          }
          break;
      }
    }
    const lines = input.split("\n");
    setCurrentLineNumber(lines.length);
    setCurrentCharPosition(lines[lines.length - 1].length);
    setReplayTimeStamp((prev) => [
      ...prev,
      {
        char: currentChar,
        textIndicatorPosition,
        currentLineNumber,
        currentCharPosition,
        errors,
        totalErrors,
        time: Date.now(),
      },
    ]);
  }

  function Backspace() {
    if (textIndicatorPosition === input.length) {
      setInput((prevInput) => prevInput.slice(0, -1));
    }

    setTextIndicatorPosition(
      (prevTextIndicatorPosition) => prevTextIndicatorPosition - 1,
    );

    if (raceTimeStamp.length > 0 && errors.length == 0) {
      setRaceTimeStamp((prev) => prev.slice(0, -1));
    }
  }

  function Enter() {
    const lines = code?.split("\n");
    if (
      input === code?.slice(0, input.length) &&
      code.charAt(input.length) === "\n"
    ) {
      let indent = "";
      let i = 0;
      while (lines?.[currentLineNumber].charAt(i) === " ") {
        indent += " ";
        i++;
      }

      setInput(input + "\n" + indent);
      setTextIndicatorPosition((prevTextIndicatorPosition) => {
        if (typeof prevTextIndicatorPosition === "number") {
          return prevTextIndicatorPosition + 1 + indent.length;
        } else {
          return prevTextIndicatorPosition;
        }
      });
    } else {
      setInput(input + "\n");
      setTextIndicatorPosition((prevTextIndicatorPosition) => {
        if (typeof prevTextIndicatorPosition === "number") {
          return prevTextIndicatorPosition + 1;
        } else {
          return prevTextIndicatorPosition;
        }
      });
    }
  }

  function Key(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== code?.slice(input.length, input.length + 1)) {
      setTotalErrors((prevTotalErrors) => prevTotalErrors + 1);
    }

    if (
      e.key === code?.[input.length] &&
      errors.length === 0 &&
      e.key !== " "
    ) {
      const currTime = Date.now();
      const timeTaken = startTime ? (currTime - startTime.getTime()) / 1000 : 0;
      setRaceTimeStamp((prev) => [
        ...prev,
        {
          char: e.key,
          accuracy: calculateAccuracy(input.length, totalErrors),
          cpm: calculateCPM(input.length, timeTaken),
          time: currTime,
        },
      ]);
      setCurrentChar("");
    }

    setInput((prevInput) => prevInput + e.key);
    setTextIndicatorPosition(
      (prevTextIndicatorPosition) => prevTextIndicatorPosition + 1,
    );
  }

  function handleRestart() {
    setStartTime(null);
    setInput("");
    setTextIndicatorPosition(0);
    setTotalErrors(0);
  }

  return (
    <>
      {/* Debug purposes */}
      {/* <pre className="max-w-sm rounded p-8"> */}
      {/*   {JSON.stringify( */}
      {/*     { */}
      {/*       participantId, */}
      {/*       user, */}
      {/*       isRaceFinished, */}
      {/*       raceStatus, */}
      {/*       participants, */}
      {/*       position, */}
      {/*     }, */}
      {/*     null, */}
      {/*     4, */}
      {/*   )} */}
      {/* </pre> */}
      <div
        className="relative flex flex-col gap-2 p-4 rounded-md lg:p-8 bg-accent w-3/4 mx-auto"
        onClick={() => {
          inputElement.current?.focus();
        }}
        role="none" // eslint fix - will remove the semantic meaning of an element while still exposing it to assistive technology
      >
        {/* <p>participant id: {participantId}</p> */}
        {raceId && raceStatus != RaceStatus.RUNNING && !startTime && (
          <MultiplayerLoadingLobby participants={participants}>
            {raceStatus === RaceStatus.WAITING && (
              <div className="flex flex-col items-center text-2xl font-bold">
                <div className="w-8 h-8 border-4 border-muted-foreground rounded-full border-t-4 border-t-warning animate-spin"></div>
                Waiting for players
              </div>
            )}
            {raceStatus === RaceStatus.COUNTDOWN &&
              !startTime &&
              Boolean(raceStartCountdown) && (
                <div className="text-center text-2xl font-bold">
                  Game starting in: {raceStartCountdown}
                </div>
              )}
          </MultiplayerLoadingLobby>
        )}
        {raceStatus === RaceStatus.RUNNING && (
          <>
            {raceId ? (
              participants.map((p) => (
                <RaceTracker
                  key={p.id}
                  position={p.position}
                  participantId={p.id}
                />
              ))
            ) : position ? (
              <RaceTracker position={position} user={user} />
            ) : null}
            <div className="mb-2 md:mb-4 flex justify-between">
              <Heading
                title="Type this code"
                description="Start typing to get racing"
              />
              {user && snippet && (
                <ReportButton
                  snippetId={snippet.id}
                  language={snippet.language as Language}
                  handleRestart={handleRestart}
                />
              )}
            </div>
            <div className="flex ">
              <div className="flex-col px-1 w-10 ">
                {code?.split("\n").map((_, line) => (
                  <div
                    key={line}
                    className={
                      currentLineNumber === line + 1
                        ? "text-center bg-slate-600 text-white  border-r-2 border-yellow-500"
                        : " text-center border-r-2 border-yellow-500"
                    }
                  >
                    {line + 1}
                  </div>
                ))}
              </div>

              {code && (
                <Code
                  code={code}
                  userInput={input}
                  textIndicatorPosition={textIndicatorPosition}
                  errors={errors}
                />
              )}
              <input
                type="text"
                defaultValue={input}
                ref={inputElement}
                onKeyDown={handleKeyboardDownEvent}
                disabled={isRaceFinished}
                className="absolute inset-y-0 left-0 w-full h-full p-8 rounded-md -z-40 focus:outline outline-blue-500 cursor-none"
                onPaste={(e) => e.preventDefault()}
              />
            </div>
          </>
        )}
        {errors.length > 0 ? (
          <span className="text-red-500">
            You must fix all errors before you can finish the race!
          </span>
        ) : null}
        {raceStatus === RaceStatus.FINISHED && (
          <div className="flex flex-col items-center text-2xl font-bold space-y-8">
            <div className="w-8 h-8 border-4 border-muted-foreground rounded-full border-t-4 border-t-warning animate-spin"></div>
            Loading race results, please wait...
          </div>
        )}
        <div className="flex justify-between items-center">
          {showRaceTimer && (
            <>
              <RaceTimer />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" onClick={handleRestart}>
                      Restart (ESC)
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Press Esc to reset</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          )}
        </div>
      </div>
      <RaceDetails submittingResults={submittingResults} />
    </>
  );
}
