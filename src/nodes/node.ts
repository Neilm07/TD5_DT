import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { NodeState, Value } from "../types";

// Déclaration globale pour stocker l'état des nœuds
declare global { var nodeData: Record<number, NodeState>; }

// Type pour les paquets échangés entre nœuds
type Paquet = {
  content: Value | null;
  type: "R" | "P";
  iteration: number;
  origin: number;
};

export async function noeud(
  nodeId: number,
  nodeCount: number,
  faultyCount: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (id: number) => void,
) {
  const app = express();
  app.use(bodyParser.json());

  if (!globalThis.nodeData) {
    globalThis.nodeData = {};
  }

  globalThis.nodeData[nodeId] = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  // Stockage temporaire des messages reçus par le nœud
  const stockageMessages: Record<number, Record<string, Packet[]>> = {};

  // Fonction pour stocker un paquet reçu
  function stockerPaquet(paquet: Packet): void {
    const { iteration, type } = paquet;
    if (!stockageMessages[iteration]) stockageMessages[iteration] = { "R": [], "P": [] };
    if (!stockageMessages[iteration][type].some(p => p.origin === paquet.origin)) {
      stockageMessages[iteration][type].push(paquet);
    }
  }

  // Envoi de message aux autres nœuds
  async function diffuserMessage(type: "R" | "P", iteration: number, contenu: Value | null) {
    for (let id = 0; id < nodeCount; id++) {
      fetch(`http://localhost:${BASE_NODE_PORT + id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, origin: nodeId, iteration, content: content }),
      });
    }
  }

  // Compte les occurrences des valeurs reçues ("0", "1" ou "?")
  function compterValeurs(messages: Paquet[]) {
    return messages.reduce((compteur, { content }) => {
      if (content !== null) compteur[content] = (compteur[content] || 0) + 1;
      return acc;
    }, { "0": 0, "1": 0, "?": 0 });
  }

  // Route pour démarrer le processus de consensus
  app.get("/start", async (_, res) => {
    if (!nodesAreReady()) return res.send("Nœuds pas encore prêts");

    if (isFaulty) return res.send("Nœud défectueux, ne peut pas démarrer");

    processusConsensus();
    return res.send("Consensus lancé");
  });

  // Algorithme du consensus
  async function processusConsensus() {
    while (!globalThis.nodeData[nodeId].decided && !isFaulty && !globalThis.nodeData[nodeId].killed) {
      globalThis.nodeData[nodeId].k! += 1;
      let valeurActuelle = globalThis.nodeData[nodeId].x!;
      let iteration = globalThis.nodeData[nodeId].k!;

      await diffuserMessage("R", iteration, valeurActuelle);

      // Attente des messages R
      while ((stockageMessages[iteration]?.["R"]?.length || 0) < nodeCount - faultyCount) {
        await new Promise(r => setTimeout(r, 10));
      }

      const valeursMajoritaires = compterValeurs(stockageMessages[iteration]["R"]);
      const majorité = Object.keys(valeursMajoritaires).find(v => valeursMajoritaires[v] > nodeCount / 2) as Value || "?";

      await diffuserMessage("P", globalThis.nodeData[nodeId].k!, majorité);

      // Attente des messages P
      while ((stockageMessages[iteration]?.["P"]?.length || 0) < nodeCount - faultyCount) {
        await new Promise(r => setTimeout(r, 10));
      }

      const validation = compterValeurs(stockageMessages[iteration]["P"]);
      const valeursValides = Object.keys(validation).filter(v => validation[v] >= faultyCount + 1 && v !== "?");

      if (valeursValides.length > 0) {
        globalThis.nodeData[nodeId].x = valeursValides[0] as Value;
        globalThis.nodeData[nodeId].decided = true;
      } else {
        globalThis.nodeData[nodeId].x = Math.random() < 0.5 ? 0 : 1;
      }
    }
  }

  // Route pour recevoir des messages des autres nœuds
  app.post("/message", bodyParser.json(), (req, res) => {
    const paquet: Packet = req.body;
    if (!globalThis.nodeData[nodeId].decided && !isFaulty && !globalThis.nodeData[nodeId].killed) {
      stockerMessage(paquet);
    }
    res.status(200).send("Message reçu");
  });

  // Route pour obtenir l'état du nœud
  app.get("/getState", (_, res) => {
    res.status(200).json(globalThis.nodeData[nodeId]);
  });

  // Route pour arrêter le consensus
  app.get("/stop", (_, res) => {
    globalThis.nodeData[nodeId].killed = true;
    res.send("Consensus arrêté");
  });

  // Lancement du serveur
  const server = app.listen(BASE_NODE_PORT + nodeId, () => {
    console.log(`Nœud démarré sur le port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}
