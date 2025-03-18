import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { NodeState, Value } from "../types";

// Déclaration globale des données des nœuds
declare global { var nodeData: Record<number, NodeState>; }

// Définition du type Packet utilisé pour les échanges entre les nœuds
type Packet = {
  content: Value | null
  origin: number
  iteration: number
  type: "R" | "P"
}

export async function node(
  nodeId: number, // ID du nœud courant
  nodeCount: number, // Nombre total de nœuds dans le réseau
  faultyCount: number, // Nombre de nœuds défectueux
  initialValue: Value, // Valeur initiale du nœud
  isFaulty: boolean, // Indique si le nœud est défectueux ou non
  nodesAreReady: () => boolean, // Fonction vérifiant si tous les nœuds sont prêts
  setNodeIsReady: (index: number) => void // Fonction appelée quand le nœud est prêt
) {
  const app = express();
  app.use(express.json());
  app.use(bodyParser.json());

  if (!globalThis.nodeData) {
    globalThis.nodeData = {};
  }

  // Initialisation des données du nœud courant
  globalThis.nodeData[nodeId] = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  // Route pour récupérer le statut du nœud
  app.get("/status", (req, res) => {
    res.status(isFaulty ? 500 : 200).send(isFaulty ? "faulty" : "live");
  });

  // Route pour obtenir l'état actuel du nœud
  app.get("/getState", (req, res) => {
    res.json(globalThis.nodeData[nodeId]).status(200);
  });

  // Route pour démarrer l'algorithme de consensus
  app.get("/start", async (req, res) => {
    if (!nodesAreReady()) {
      return res.send("not ready").status(400);
    } else {
      consensusProcess();
      return res.send("consencus processus initialized").status(200);
    }
  });

  const messageStore: Record<number, Record<string, Packet[]>> = {};

  // Stocke les paquets reçus par le nœud
  function storePacket(packet: Packet): void {
    const { iteration, type } = packet;
    if (!messageStore[iteration]) messageStore[iteration] = { "R": [], "P": [] };
    if (!messageStore[iteration][type].some(p => p.origin === packet.origin)) {
      messageStore[iteration][type].push(packet);
    }
  }

  // Récupère les paquets reçus pour une itération et une phase spécifiques
  function getPackets(iteration: number, phase: "R" | "P"): Packet[] {
    return messageStore[iteration]?.[phase] || [];
  }

  // Compte les paquets reçus pour une itération et une phase spécifiques
  function countPackets(iteration: number, phase: "R" | "P"): number {
    return messageStore[iteration]?.[phase]?.length || 0;
  }

  // Diffuse un message à tous les nœuds du réseau
  async function dispatchMessage(type: "R" | "P", iteration: number, content: Value | null) {
    for (let i = 0; i < nodeCount; i++) {
      fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, origin: nodeId, iteration, content }),
      }).catch(() => {});
    }
  }

  // Compte les valeurs reçues parmi les paquets (0, 1 ou ?)
  function evaluatePackets(messages: Packet[]): Record<Value, number> {
    return messages.reduce((acc, { content }) => {
      if (content !== null) acc[content] = (acc[content] || 0) + 1;
      return acc;
    }, { 0: 0, 1: 0, "?": 0 } as Record<Value, number>);
  }

  // Implémentation du processus de consensus de Ben-Or
  async function consensusProcess() {
    while (!globalThis.nodeData[nodeId].decided) {
      if (globalThis.nodeData[nodeId].killed || isFaulty) return;

      globalThis.nodeData[nodeId].k! += 1;
      let value = globalThis.nodeData[nodeId].x!;
      let iteration = globalThis.nodeData[nodeId].k!;

      await dispatchMessage("R", iteration, value);
      while (countPackets(iteration, "R") < nodeCount - faultyCount) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const phaseR = getPackets(iteration, "R");
      const majorities = Object.entries(evaluatePackets(phaseR)).filter(([_, count]) => count > nodeCount / 2).map(([key]) => (key === "0" ? 0 : key === "1" ? 1 : "?")) as Value[];
      await dispatchMessage("P", iteration, majorities.length > 0 ? majorities[0] : "?");

      while (countPackets(iteration, "P") < nodeCount - faultyCount) { await new Promise((resolve) => setTimeout(resolve, 10)); }

      const phaseP = getPackets(iteration, "P");
      const validValues = Object.entries(evaluatePackets(phaseP)).filter(([key, count]) => count >= faultyCount + 1 && key !== "?").map(([key]) => (key === "0" ? 0 : 1)) as Value[];

      if (validValues.length > 0) {
        globalThis.nodeData[nodeId].x = validValues[0];
        globalThis.nodeData[nodeId].decided = true;
      } else {
        const possibleValues = Object.entries(evaluatePackets(phaseP)).filter(([key, count]) => count >= 1 && key !== "?").map(([key]) => (key === "0" ? 0 : 1)) as Value[];
        globalThis.nodeData[nodeId].x = possibleValues.length > 0 ? possibleValues[0] : Math.random() < 0.5 ? 0 : 1;
      }
    }
  }

  // Réception des messages des autres nœuds
  app.post("/message", (req, res) => {
    if (globalThis.nodeData[nodeId].killed) {
      return res.status(400).send("Node is stopped");
    }

    const { type, origin, iteration, content } = req.body;
    if (!globalThis.nodeData[nodeId].decided) {
      storePacket({ type, origin, iteration, content });
    }
    return res.status(200).send("Message received");
  });

  // Arrête le processus de consensus
  app.get("/stop", (req, res) => {
    globalThis.nodeData[nodeId].killed = true;
    res.send("terminated").status(200);
  });

  const server = app.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is operational on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}